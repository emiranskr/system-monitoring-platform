using SysMon.Agent.Collectors;

namespace Agent.Tests.Collectors;

/// <summary>
/// Bulgu (A5 gercek servis kosusu): dusuk yetkili hesapta PdhAddEnglishCounter basarisiz oldu ve kurucu
/// istisnasi tum servisi durdurdu. Tasarim: collector hatasi collector_status olur, agent calismaya devam eder.
/// </summary>
public class PdhResilienceTests
{
    private sealed class BrokenCpu(string error) : ICpuSource
    {
        public string? Error => error;
        public double? ReadUtilizationPercent() => null;
    }

    [Fact]
    public void PdhCpuSource_gecersiz_sayac_yolunda_kurucu_istisna_firlatmaz_ve_hatayi_bildirir()
    {
        if (!OperatingSystem.IsWindows()) return;
        using var src = new PdhCpuSource([@"\Olmayan Nesne(_Total)\Olmayan Sayac"]);
        var v = src.ReadUtilizationPercent();
        Assert.Null(v);
        Assert.NotNull(src.Error);
        Assert.Contains("PdhAddEnglishCounter", src.Error);
    }

    [Fact]
    public async Task PdhCpuSource_ilk_yol_gecersizse_ikinci_yola_duser_ve_gercek_deger_okur()
    {
        if (!OperatingSystem.IsWindows()) return;
        using var src = new PdhCpuSource([@"\Olmayan Nesne(_Total)\X", @"\Processor(_Total)\% Processor Time"]);
        Assert.Null(src.ReadUtilizationPercent()); // baseline
        await Task.Delay(500);
        var v = src.ReadUtilizationPercent();
        Assert.NotNull(v);
        Assert.Null(src.Error);
    }

    [Fact]
    public async Task CpuCollector_kaynak_hatali_ise_istisna_firlatir_ve_runner_durum_hata_olarak_raporlar_diger_collectorlar_calisir()
    {
        var runner = new CollectorRunner(
            [new CpuCollector(new BrokenCpu("erisim reddedildi")), new MemoryCollector(new FakeMem())],
            TimeSpan.FromSeconds(2));

        var r = await runner.RunOnceAsync(CancellationToken.None);

        Assert.Contains(r.Statuses, s => s.Name == "cpu" && !s.Ok && s.Message!.Contains("erisim reddedildi"));
        Assert.Contains(r.Statuses, s => s.Name == "memory" && s.Ok);
        Assert.Equal(50.0, r.Metrics["mem.used_pct"]);
        Assert.False(r.Metrics.ContainsKey("cpu.total"));
    }

    private sealed class FakeMem : IMemoryInfoSource
    {
        public MemoryInfo Read() => new(1000, 500);
    }
}
