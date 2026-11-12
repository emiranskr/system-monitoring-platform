using System.Text.Json;
using SysMon.Agent;
using SysMon.Agent.Collectors;
using SysMon.Agent.Transport;

namespace Agent.Tests;

/// <summary>Sunucunun ingest yanitindaki config.interval_seconds ornekleme araligini belirler (depolama butcesi, M2 olcumu).</summary>
public class SamplingConfigTests
{
    private static JsonElement J(string json) => JsonDocument.Parse(json).RootElement.Clone();

    [Theory]
    [InlineData("1", 1)]
    [InlineData("5", 5)]
    [InlineData("300", 300)]
    public void Gecerli_saniye_uygulanir(string json, int seconds)
    {
        var c = new SamplingConfig(TimeSpan.FromSeconds(5));
        Assert.True(c.TryApplyServerSeconds(J(json)));
        Assert.Equal(TimeSpan.FromSeconds(seconds), c.Interval);
    }

    [Theory]
    [InlineData("0")]
    [InlineData("-5")]
    [InlineData("301")]
    [InlineData("100000")]
    [InlineData("1.5")]
    [InlineData("\"7\"")]
    [InlineData("null")]
    [InlineData("true")]
    [InlineData("[1]")]
    [InlineData("{}")]
    [InlineData("99999999999999999999")]
    public void Gecersiz_deger_yok_sayilir_onceki_aralik_korunur(string json)
    {
        var c = new SamplingConfig(TimeSpan.FromSeconds(5));
        Assert.False(c.TryApplyServerSeconds(J(json)));
        Assert.Equal(TimeSpan.FromSeconds(5), c.Interval);
    }

    private sealed class Counter : ICollector
    {
        public long Calls;
        public string Name => "counter";
        public TimeSpan Interval => TimeSpan.FromMilliseconds(5);
        public Task<IReadOnlyDictionary<string, double?>> CollectAsync(CancellationToken ct) =>
            Task.FromResult<IReadOnlyDictionary<string, double?>>(new Dictionary<string, double?> { ["cpu.total"] = Interlocked.Increment(ref Calls) });
    }

    private sealed class Sink : IBatchSink
    {
        public Batch Enqueue(IReadOnlyList<Sample> samples) => new(Guid.Empty, 0, DateTimeOffset.UtcNow, samples);
    }

    [Fact]
    public async Task Pipeline_calisirken_aralik_degisince_ornekleme_hizi_degisir()
    {
        var config = new SamplingConfig(TimeSpan.FromMilliseconds(10));
        var counter = new Counter();
        var p = new SamplingPipeline(new CollectorRunner([counter], TimeSpan.FromSeconds(10)), new Sink(), () => DateTimeOffset.UtcNow,
            TimeSpan.FromMilliseconds(10), TimeSpan.FromMilliseconds(50), sampling: config);

        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(30));
        var run = p.RunAsync(cts.Token);
        await TestUtil.WaitUntil(() => Interlocked.Read(ref counter.Calls) >= 30);   // hizli: 10 ms
        config.Interval = TimeSpan.FromMilliseconds(300);                              // sunucu yavaslatti
        await Task.Delay(400);                                                         // gecis icin pay
        var before = Interlocked.Read(ref counter.Calls);
        await Task.Delay(1500);
        var delta = Interlocked.Read(ref counter.Calls) - before;
        await cts.CancelAsync();
        await run;

        Assert.InRange(delta, 2, 9); // ~5 beklenir (1.5 sn / 300 ms); 10 ms hizinda ~150 olurdu
    }
}
