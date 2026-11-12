using SysMon.Agent.Collectors;

namespace Agent.Tests.Collectors;

public class RunnerTests
{
    private sealed class Fake(string name, Func<CancellationToken, Task<IReadOnlyDictionary<string, double?>>> f) : ICollector
    {
        public string Name => name;
        public TimeSpan Interval => TimeSpan.FromSeconds(1);
        public Task<IReadOnlyDictionary<string, double?>> CollectAsync(CancellationToken ct) => f(ct);
    }

    private static Fake Ok(string name, string metric, double v) =>
        new(name, _ => Task.FromResult<IReadOnlyDictionary<string, double?>>(new Dictionary<string, double?> { [metric] = v }));

    [Fact]
    public async Task Bir_collector_firlatirsa_digerleri_calismaya_devam_eder()
    {
        var bad = new Fake("bad", _ => throw new InvalidOperationException("patladi"));
        var runner = new CollectorRunner([bad, Ok("cpu", "cpu.total", 5)], TimeSpan.FromSeconds(10));

        var r = await runner.RunOnceAsync(CancellationToken.None);

        Assert.Equal(5, r.Metrics["cpu.total"]);
        Assert.Contains(r.Statuses, s => s.Name == "bad" && !s.Ok && s.Message!.Contains("patladi"));
        Assert.Contains(r.Statuses, s => s.Name == "cpu" && s.Ok);
    }

    [Fact]
    public async Task Zaman_asimi_collector_status_uretir_ve_digerlerini_engellemez()
    {
        var hang = new Fake("hang", async ct =>
        {
            await Task.Delay(Timeout.Infinite, ct);
            return new Dictionary<string, double?>();
        });
        // Zaman asimi HER collector icin gecerlidir (hizli "mem" dahil): 100 ms, is parcacigi havuzu aciken hizli collector'i
        // da zaman asimina ugratip testi aralikli kiriyordu. 1 sn: takilan collector yine zaman asimina ugrar, hizlisi ugramaz.
        var runner = new CollectorRunner([hang, Ok("mem", "mem.used_pct", 40)], TimeSpan.FromMilliseconds(1000));

        var r = await runner.RunOnceAsync(CancellationToken.None);

        Assert.Equal(40, r.Metrics["mem.used_pct"]);
        Assert.Contains(r.Statuses, s => s.Name == "hang" && !s.Ok && s.Message!.Contains("zaman asimi"));
    }

    [Fact]
    public async Task Gecersiz_metrik_adi_atilir_ve_durum_hata_olur()
    {
        var evil = new Fake("evil", _ => Task.FromResult<IReadOnlyDictionary<string, double?>>(
            new Dictionary<string, double?> { ["../etc"] = 1, ["cpu.total"] = 2 }));
        var r = await new CollectorRunner([evil], TimeSpan.FromSeconds(10)).RunOnceAsync(CancellationToken.None);

        Assert.False(r.Metrics.ContainsKey("../etc"));
        Assert.Equal(2, r.Metrics["cpu.total"]);
        Assert.Contains(r.Statuses, s => s.Name == "evil" && !s.Ok);
    }

    [Fact]
    public async Task Iptal_istegi_OperationCanceledException_olarak_yayilir()
    {
        using var cts = new CancellationTokenSource();
        await cts.CancelAsync();
        var runner = new CollectorRunner([Ok("cpu", "cpu.total", 1)], TimeSpan.FromSeconds(10));
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => runner.RunOnceAsync(cts.Token));
    }
}
