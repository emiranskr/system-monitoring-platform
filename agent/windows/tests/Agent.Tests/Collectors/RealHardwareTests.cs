using SysMon.Agent.Collectors;

namespace Agent.Tests.Collectors;

/// <summary>Gercek Windows kaynaklari; sahte veri kullanmaz (yalnizca Windows'ta calisir).</summary>
public class RealHardwareTests
{
    [Fact]
    public async Task Gercek_bellek_makul_aralikta()
    {
        if (!OperatingSystem.IsWindows()) return;
        var m = await new MemoryCollector(new WindowsMemoryInfoSource()).CollectAsync(default);
        Assert.InRange(m["mem.used_pct"]!.Value, 1, 99.9);
        Assert.True(m["mem.total_bytes"] > 1_000_000_000);
    }

    [Fact]
    public async Task Gercek_disk_C_surucusu_var()
    {
        if (!OperatingSystem.IsWindows()) return;
        var m = await new DiskCollector(new SystemDriveSource()).CollectAsync(default);
        Assert.InRange(m["disk.C.used_pct"]!.Value, 0.1, 100);
    }

    [Fact]
    public async Task Gercek_cpu_PDH_Ingilizce_sayacla_okunur()
    {
        if (!OperatingSystem.IsWindows()) return;
        using var src = new PdhCpuSource();
        Assert.Null(src.ReadUtilizationPercent()); // ilk ornek baseline
        await Task.Delay(500);
        var v = src.ReadUtilizationPercent();
        Assert.NotNull(v);
        Assert.InRange(v!.Value, 0, 400);
    }

    [Fact]
    public async Task Gercek_ag_iki_olcumde_negatif_olmayan_deger_uretir()
    {
        if (!OperatingSystem.IsWindows()) return;
        long t = 0;
        var c = new NetworkCollector(new SystemNetworkSource(), () => t);
        await c.CollectAsync(default);
        t = 1000;
        var m = await c.CollectAsync(default);
        Assert.All(m, kv => Assert.True(kv.Value >= 0));
    }
}
