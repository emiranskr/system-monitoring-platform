using SysMon.Agent;
using SysMon.Agent.Collectors;
using SysMon.Agent.Transport;

namespace Agent.Tests.Transport;

/// <summary>
/// Uctan uca kesinti senaryosu (gercek Kestrel HTTPS sunucusu, gercek Spool + SamplingPipeline + Uploader + UploadRunner).
/// Varsayilan (hizli) mod: kisa aralik ve ~3 sn kesinti, normal takimin parcasi.
/// Gercek zamanli mod: SYSMON_SOAK_REAL_TIMING=1 (1 sn ornek / 5 sn batch), SYSMON_SOAK_BASELINE_SECONDS,
/// SYSMON_SOAK_OUTAGE_SECONDS (orn. 600). Her ornek degeri benzersiz bir sayac oldugundan kayip ve cift kayit kesin sayilir.
/// </summary>
public sealed class OutageSoakTests : IAsyncDisposable
{
    private readonly string _dir = Path.Combine(Path.GetTempPath(), "sysmon-soak-" + Guid.NewGuid().ToString("N"));
    private readonly TestHttpsServer _srv = new();

    public async ValueTask DisposeAsync()
    {
        await _srv.DisposeAsync();
        if (Directory.Exists(_dir)) Directory.Delete(_dir, true);
    }

    private sealed class UniqueCounter : ICollector
    {
        public long Calls;
        public string Name => "counter";
        public TimeSpan Interval => TimeSpan.FromSeconds(1);
        public Task<IReadOnlyDictionary<string, double?>> CollectAsync(CancellationToken ct) =>
            Task.FromResult<IReadOnlyDictionary<string, double?>>(
                new Dictionary<string, double?> { ["cpu.total"] = Interlocked.Increment(ref Calls) });
    }

    private static int Env(string name, int fallback) =>
        int.TryParse(Environment.GetEnvironmentVariable(name), out var v) ? v : fallback;

    [Fact]
    public async Task Kesinti_boyunca_ve_sonrasinda_sifir_kayip_sifir_cift_kayit_seq_bosluksuz()
    {
        var real = Environment.GetEnvironmentVariable("SYSMON_SOAK_REAL_TIMING") == "1";
        var sample = real ? TimeSpan.FromSeconds(1) : TimeSpan.FromMilliseconds(40);
        var batch = real ? TimeSpan.FromSeconds(5) : TimeSpan.FromMilliseconds(200);
        var baseline = TimeSpan.FromSeconds(Env("SYSMON_SOAK_BASELINE_SECONDS", real ? 60 : 1));
        var outage = TimeSpan.FromSeconds(Env("SYSMON_SOAK_OUTAGE_SECONDS", real ? 600 : 3));
        var drainTimeout = real ? TimeSpan.FromMinutes(7) : TimeSpan.FromSeconds(60); // geri cekilme tavani 5 dk

        await _srv.StartAsync();
        var spool = new Spool(_dir, new SpoolLimits(50_000_000, TimeSpan.FromHours(24), 1_000_000), () => DateTimeOffset.UtcNow);
        var counter = new UniqueCounter();
        var pipeline = new SamplingPipeline(new CollectorRunner([counter], TimeSpan.FromSeconds(10)), spool,
            () => DateTimeOffset.UtcNow, sample, batch);
        var uploader = new Uploader(spool, HttpClients.Create([SpkiPin.Compute(_srv.Cert)]), _srv.Url, () => "tok",
            AgentOptions.Parse([]), () => DateTimeOffset.UtcNow);
        var waits = new List<(UploadOutcome O, TimeSpan W)>();
        var runner = new UploadRunner(uploader.UploadOnceAsync, Task.Delay, new Random(), onWait: (o, w) => { lock (waits) waits.Add((o, w)); });

        using var pipeCts = new CancellationTokenSource();
        using var upCts = new CancellationTokenSource();
        var pipeTask = pipeline.RunAsync(pipeCts.Token);
        var upTask = runner.RunAsync(upCts.Token);

        await Task.Delay(baseline);
        await _srv.StopAsync();                    // gercek kesinti: port kapali
        var outageStart = DateTimeOffset.UtcNow;
        await Task.Delay(outage);
        var pendingDuringOutage = spool.PendingCount;
        await _srv.StartAsync();                   // sunucu ayni port ve sertifikayla geri geldi
        var recovered = DateTimeOffset.UtcNow;

        // Ornekleme dursun (kalanlar spool'a yazilir), sonra spool bosalana kadar yuklemeye devam.
        await pipeCts.CancelAsync();
        await pipeTask;
        var deadline = DateTimeOffset.UtcNow + drainTimeout;
        while (spool.PendingCount > 0 && DateTimeOffset.UtcNow < deadline) await Task.Delay(200);
        var drained = spool.PendingCount == 0;
        var drainSeconds = (DateTimeOffset.UtcNow - recovered).TotalSeconds;
        await upCts.CancelAsync();
        await upTask;

        Assert.True(pendingDuringOutage > 0, "kesinti sirasinda spool'da biriken batch yok (senaryo anlamsiz)");
        Assert.True(drained, $"spool bosalmadi: {spool.PendingCount} batch kaldi (sure {drainSeconds:0} sn)");

        // Sunucu tarafi: (epoch, seq) ile tekillestir (gercek sunucu PK ile idempotent); ham tekrar sayisi bilgi icin.
        var raw = _srv.Bodies.ToList();
        var unique = raw.GroupBy(b => (b.GetProperty("spool_epoch").GetString(), b.GetProperty("seq").GetInt64()))
            .Select(g => g.First()).OrderBy(b => b.GetProperty("seq").GetInt64()).ToList();
        var seqs = unique.Select(b => b.GetProperty("seq").GetInt64()).ToList();
        Assert.Equal(Enumerable.Range(0, seqs.Count).Select(i => (long)i), seqs); // bosluksuz, sifirdan

        var values = unique.SelectMany(b => b.GetProperty("samples").EnumerateArray())
            .Select(s => (long)s.GetProperty("m").GetProperty("cpu.total").GetDouble()).ToList();
        Assert.Equal(counter.Calls, values.Count);                                // hic ornek kaybolmadi
        Assert.Equal(values.Count, values.Distinct().Count());                    // cift kayit yok
        Assert.Equal(Enumerable.Range(1, (int)counter.Calls).Select(i => (long)i), values.OrderBy(v => v)); // 1..N eksiksiz

        // Rapor (xUnit cikti: ortam degiskeniyle gercek koşuda okunur)
        Console.WriteLine($"SOAK_RAPOR gercek_zaman={real} kesinti_sn={outage.TotalSeconds:0} kesintide_biriken_batch={pendingDuringOutage} " +
                          $"toplam_ornek={counter.Calls} batch={seqs.Count} ham_istek={raw.Count} tekrar={raw.Count - unique.Count} " +
                          $"bosalma_sn={drainSeconds:0} retry_sayisi={waits.Count(w => w.O == UploadOutcome.Retry)} " +
                          $"max_bekleme_sn={(waits.Count == 0 ? 0 : waits.Max(w => w.W.TotalSeconds)):0.0}");
        _ = outageStart;
    }
}
