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

        using var cts = new CancellationTokenSource(TimeSpan.FromMilliseconds(500));
        await pipeline.RunAsync(cts.Token);

        Assert.True(spool.PendingCount >= 2, $"en az 2 batch beklenir, gelen: {spool.PendingCount}");
        var first = spool.PeekOldest()!;
        Assert.True(first.Samples.Count >= 2);
        Assert.All(first.Samples, s => Assert.True(s.M.ContainsKey("cpu.total")));
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
