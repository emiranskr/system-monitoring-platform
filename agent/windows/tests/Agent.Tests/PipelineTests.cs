using SysMon.Agent;
using SysMon.Agent.Collectors;
using SysMon.Agent.Transport;

namespace Agent.Tests;

public sealed class PipelineTests : IDisposable
{
    private readonly string _dir = Path.Combine(Path.GetTempPath(), "sysmon-pipe-" + Guid.NewGuid().ToString("N"));

    public void Dispose()
    {
        if (Directory.Exists(_dir)) Directory.Delete(_dir, true);
    }

    private sealed class Counter : ICollector
    {
        public int Calls;
        public string Name => "counter";
        public TimeSpan Interval => TimeSpan.FromMilliseconds(10);
        public Task<IReadOnlyDictionary<string, double?>> CollectAsync(CancellationToken ct) =>
            Task.FromResult<IReadOnlyDictionary<string, double?>>(
                new Dictionary<string, double?> { ["cpu.total"] = Interlocked.Increment(ref Calls) });
    }

    [Fact]
    public async Task Hat_ornekleri_toplar_ve_batch_araliginda_spoola_yazar()
    {
        var spool = new Spool(_dir, new SpoolLimits(50_000_000, TimeSpan.FromHours(24), 1_000_000), () => DateTimeOffset.UtcNow);
        var runner = new CollectorRunner([new Counter()], TimeSpan.FromSeconds(1));
        var pipeline = new SamplingPipeline(runner, spool, () => DateTimeOffset.UtcNow,
            sampleInterval: TimeSpan.FromMilliseconds(20), batchInterval: TimeSpan.FromMilliseconds(120));

        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(30));
        var run = pipeline.RunAsync(cts.Token);
        await TestUtil.WaitUntil(() => spool.PendingCount >= 2);
        await cts.CancelAsync();
        await run;

        Assert.True(spool.PendingCount >= 2, $"en az 2 batch beklenir, gelen: {spool.PendingCount}");
        // Tek bir batch'in ornek sayisi zamanlamaya baglidir (yavas CI kosucusunda ilk batch'e 1 ornek dusebilir); degismez olan: TUM batch'lerde toplanan
        // ornekler birden fazladir, her batch bos degildir ve her ornek beklenen metrigi tasir.
        var samples = 0;
        for (var b = spool.PeekOldest(); b is not null; b = spool.PeekOldest())
        {
            Assert.NotEmpty(b.Samples);
            Assert.All(b.Samples, s => Assert.True(s.M.ContainsKey("cpu.total")));
            samples += b.Samples.Count;
            spool.Ack(b);
        }
        Assert.True(samples >= 2, $"toplam en az 2 ornek beklenir, gelen: {samples}");
    }

    [Fact]
    public async Task Iptalde_kalan_ornekler_spoola_yazilir_kayip_olmaz()
    {
        var spool = new Spool(_dir, new SpoolLimits(50_000_000, TimeSpan.FromHours(24), 1_000_000), () => DateTimeOffset.UtcNow);
        var c = new Counter();
        var pipeline = new SamplingPipeline(new CollectorRunner([c], TimeSpan.FromSeconds(1)), spool,
            () => DateTimeOffset.UtcNow, TimeSpan.FromMilliseconds(20), batchInterval: TimeSpan.FromHours(1));

        using var cts = new CancellationTokenSource(TimeSpan.FromMilliseconds(200));
        await pipeline.RunAsync(cts.Token);

        var total = 0;
        for (var b = spool.PeekOldest(); b is not null; b = spool.PeekOldest())
        {
            total += b.Samples.Count;
            spool.Ack(b);
        }
        Assert.Equal(c.Calls, total);
    }
}

public class OptionsParseTests
{
    [Fact]
    public void Parse_server_token_ve_data_dir_degerlerini_okur()
    {
        var o = AgentOptions.Parse(["--server", "https://m.example.com", "--token-file", "t.txt", "--data-dir", "d"]);
        Assert.Equal("https://m.example.com", o.Server);
        Assert.Equal("t.txt", o.TokenFile);
        Assert.Equal("d", o.DataDir);
    }

    [Fact]
    public void Parse_deger_eksikse_hata_verir()
    {
        Assert.Throws<ArgumentException>(() => AgentOptions.Parse(["--server"]));
    }
}

public sealed class PipelineStatusTests : IDisposable
{
    private readonly string _dir = Path.Combine(Path.GetTempPath(), "sysmon-pst-" + Guid.NewGuid().ToString("N"));

    public void Dispose()
    {
        if (Directory.Exists(_dir)) Directory.Delete(_dir, true);
    }

    private sealed class Flaky : ICollector
    {
        public int Calls;
        public string Name => "flaky";
        public TimeSpan Interval => TimeSpan.FromMilliseconds(10);
        public Task<IReadOnlyDictionary<string, double?>> CollectAsync(CancellationToken ct)
        {
            var n = Interlocked.Increment(ref Calls);
            // 1-4. cagri hata, sonra duzelir
            if (n <= 4) throw new InvalidOperationException("erisim reddedildi");
            return Task.FromResult<IReadOnlyDictionary<string, double?>>(new Dictionary<string, double?> { ["cpu.total"] = 5 });
        }
    }

    [Fact]
    public async Task Collector_durum_degisimi_bir_kez_bildirilir_tekrarlayan_hata_spamlanmaz_ve_duzelme_bildirilir()
    {
        var spool = new Spool(_dir, new SpoolLimits(50_000_000, TimeSpan.FromHours(24), 1_000_000), () => DateTimeOffset.UtcNow);
        var events = new List<(string Name, bool Ok, string? Msg)>();
        var pipeline = new SamplingPipeline(new CollectorRunner([new Flaky()], TimeSpan.FromSeconds(1)), spool,
            () => DateTimeOffset.UtcNow, TimeSpan.FromMilliseconds(10), TimeSpan.FromHours(1),
            onStatusChange: s => events.Add((s.Name, s.Ok, s.Message)));

        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(30));
        var run = pipeline.RunAsync(cts.Token);
        await TestUtil.WaitUntil(() => { lock (events) return events.Count >= 2; });
        await cts.CancelAsync();
        await run;

        // 4 ardisik hata -> yalnizca 1 "hata" bildirimi; sonra duzelme -> 1 "ok" bildirimi
        Assert.Equal(2, events.Count);
        Assert.False(events[0].Ok);
        Assert.Contains("erisim reddedildi", events[0].Msg);
        Assert.True(events[1].Ok);
    }
}
