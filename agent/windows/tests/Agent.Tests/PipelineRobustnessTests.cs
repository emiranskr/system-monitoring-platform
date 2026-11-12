using SysMon.Agent.Collectors;
using SysMon.Agent.Transport;

namespace Agent.Tests;

/// <summary>M1 inceleme bulgulari: O1 (yazma hatasi servisi dusurmemeli), O5 (takilan collector birikmemeli), O6 (NIC anahtar cakismasi), NaN.</summary>
public class PipelineRobustnessTests
{
    private sealed class FlakySink(int failures) : IBatchSink
    {
        public int Attempts;
        public readonly List<Batch> Stored = [];
        public Batch Enqueue(IReadOnlyList<Sample> samples)
        {
            if (Interlocked.Increment(ref Attempts) <= failures) throw new IOException("disk dolu");
            var b = new Batch(Guid.Empty, Stored.Count, DateTimeOffset.UtcNow, samples);
            lock (Stored) Stored.Add(b);
            return b;
        }
    }

    private sealed class Counter : ICollector
    {
        public long Calls;
        public string Name => "counter";
        public TimeSpan Interval => TimeSpan.FromMilliseconds(5);
        public Task<IReadOnlyDictionary<string, double?>> CollectAsync(CancellationToken ct) =>
            Task.FromResult<IReadOnlyDictionary<string, double?>>(new Dictionary<string, double?> { ["cpu.total"] = Interlocked.Increment(ref Calls) });
    }

    [Fact]
    public async Task O1_Spool_yazma_hatasi_hattin_dusmesine_yol_acmaz_ornekler_korunur_ve_sonra_yazilir()
    {
        var sink = new FlakySink(failures: 3);
        var errors = new List<Exception>();
        var c = new Counter();
        var p = new SamplingPipeline(new CollectorRunner([c], TimeSpan.FromSeconds(10)), sink, () => DateTimeOffset.UtcNow,
            TimeSpan.FromMilliseconds(10), TimeSpan.FromMilliseconds(30), onError: errors.Add);

        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(30));
        var run = p.RunAsync(cts.Token);
        await TestUtil.WaitUntil(() => { lock (sink.Stored) return sink.Stored.Count > 0; }); // en az bir basarili yazim
        await cts.CancelAsync();
        await run; // istisna firlatmamali

        Assert.NotEmpty(errors);
        var stored = sink.Stored.SelectMany(b => b.Samples).Select(s => (long)s.M["cpu.total"]!.Value).OrderBy(v => v).ToList();
        Assert.Equal(c.Calls, stored.Count);                       // hicbir ornek kaybolmadi
        Assert.Equal(Enumerable.Range(1, (int)c.Calls).Select(i => (long)i), stored);
    }

    [Fact]
    public async Task O1_Surekli_yazma_hatasinda_tampon_sinirlidir_en_eski_ornekler_atilir_ve_sayilir()
    {
        var sink = new FlakySink(failures: int.MaxValue);
        var p = new SamplingPipeline(new CollectorRunner([new Counter()], TimeSpan.FromSeconds(10)), sink,
            () => DateTimeOffset.UtcNow, TimeSpan.FromMilliseconds(5), TimeSpan.FromMilliseconds(20), maxBufferedSamples: 20);

        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(30));
        var run = p.RunAsync(cts.Token);
        await TestUtil.WaitUntil(() => p.DroppedSamples > 0);
        await cts.CancelAsync();
        await run;

        Assert.True(p.DroppedSamples > 0, "tampon sinirini asinca en eski ornekler sayilarak atilmali");
        Assert.True(p.BufferedSamples <= 20);
    }

    [Fact]
    public async Task NaN_ve_sonsuz_degerler_null_olur_ve_JSON_yazimini_bozmaz()
    {
        var bad = new Fake("bad", new Dictionary<string, double?>
        {
            ["cpu.total"] = double.NaN, ["mem.used_pct"] = double.PositiveInfinity, ["disk.C.used_pct"] = double.NegativeInfinity, ["net.e.rx_bps"] = 5,
        });
        var r = await new CollectorRunner([bad], TimeSpan.FromSeconds(10)).RunOnceAsync(CancellationToken.None);
        Assert.Null(r.Metrics["cpu.total"]);
        Assert.Null(r.Metrics["mem.used_pct"]);
        Assert.Null(r.Metrics["disk.C.used_pct"]);
        Assert.Equal(5, r.Metrics["net.e.rx_bps"]);

        var dir = Path.Combine(Path.GetTempPath(), "sysmon-nan-" + Guid.NewGuid().ToString("N"));
        try
        {
            var spool = new Spool(dir, new SpoolLimits(1_000_000, TimeSpan.FromHours(1), 100_000), () => DateTimeOffset.UtcNow);
            spool.Enqueue([new Sample(DateTimeOffset.UtcNow, new Dictionary<string, double?>(r.Metrics))]); // istisna firlatmamali
            Assert.Equal(1, spool.PendingCount);
        }
        finally { Directory.Delete(dir, true); }
    }

    private sealed class Fake(string name, Dictionary<string, double?> data) : ICollector
    {
        public string Name => name;
        public TimeSpan Interval => TimeSpan.FromSeconds(1);
        public Task<IReadOnlyDictionary<string, double?>> CollectAsync(CancellationToken ct) =>
            Task.FromResult<IReadOnlyDictionary<string, double?>>(data);
    }

    private sealed class Hanging : ICollector
    {
        public int Started;
        /// <summary>Test serbest birakana kadar bloklar (zamana bagimli Thread.Sleep yerine: havuz aciken de deterministik).</summary>
        public readonly ManualResetEventSlim Release = new(false);
        public string Name => "hang";
        public TimeSpan Interval => TimeSpan.FromSeconds(1);
        public Task<IReadOnlyDictionary<string, double?>> CollectAsync(CancellationToken ct)
        {
            Interlocked.Increment(ref Started);
            Release.Wait(); // iptali yok sayan, bloklayan cagri
            return Task.FromResult<IReadOnlyDictionary<string, double?>>(new Dictionary<string, double?>());
        }
    }

    [Fact]
    public async Task O5_Takilan_collector_icin_onceki_cagri_bitmeden_yenisi_baslatilmaz()
    {
        var h = new Hanging();
        var runner = new CollectorRunner([h], TimeSpan.FromMilliseconds(50));
        var statuses = new List<CollectorStatus>();
        for (var i = 0; i < 5; i++) statuses.AddRange((await runner.RunOnceAsync(CancellationToken.None)).Statuses);

        Assert.Equal(1, h.Started); // 5 tur boyunca yalnizca 1 cagri baslatildi (takili cagri serbest birakilmadi)
        Assert.All(statuses, s => Assert.False(s.Ok));
        Assert.Contains(statuses, s => s.Message!.Contains("hala calisiyor"));

        h.Release.Set(); // takili cagri bitince yeniden baslatilabilir
        await TestUtil.WaitUntil(() => { runner.RunOnceAsync(CancellationToken.None).GetAwaiter().GetResult(); return Volatile.Read(ref h.Started) >= 2; });
        Assert.Equal(2, h.Started);
    }

    private sealed class Nics : INetworkSource
    {
        public List<NicCounters> Next = [];
        public IReadOnlyList<NicCounters> Read() => Next;
    }

    [Fact]
    public async Task O6_Farkli_Unicode_adli_arayuzler_ayni_anahtara_dusmez_ve_sahte_hiz_uretmez()
    {
        var src = new Nics { Next = [new NicCounters("Ağ", 1000, 1000), new NicCounters("Aş", 9_000_000_000, 9_000_000_000)] };
        long now = 0;
        var c = new NetworkCollector(src, () => now);
        await c.CollectAsync(default);
        now = 1000;
        src.Next = [new NicCounters("Ağ", 2000, 1500), new NicCounters("Aş", 9_000_000_100, 9_000_000_200)];
        var m = await c.CollectAsync(default);

        var rx = m.Where(kv => kv.Key.EndsWith(".rx_bps")).OrderBy(kv => kv.Value).Select(kv => kv.Value).ToList();
        Assert.Equal(2, rx.Count);          // iki ayri anahtar
        Assert.Equal(100.0, rx[0]);         // B: 100 bayt/sn
        Assert.Equal(1000.0, rx[1]);        // A: 1000 bayt/sn (sahte dev hiz yok)
    }

    [Fact]
    public async Task O6_ASCII_adli_arayuzun_anahtari_degismez()
    {
        var src = new Nics { Next = [new NicCounters("Ethernet", 0, 0)] };
        long now = 0;
        var c = new NetworkCollector(src, () => now);
        await c.CollectAsync(default);
        now = 1000;
        src.Next = [new NicCounters("Ethernet", 10, 20)];
        var m = await c.CollectAsync(default);
        Assert.True(m.ContainsKey("net.Ethernet.rx_bps"));
    }
}
