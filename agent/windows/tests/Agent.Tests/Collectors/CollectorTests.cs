using SysMon.Agent.Collectors;

namespace Agent.Tests.Collectors;

public class CollectorTests
{
    private sealed class FakeMem(ulong total, ulong avail) : IMemoryInfoSource
    {
        public MemoryInfo Read() => new(total, avail);
    }

    private sealed class FakeDrives(params DriveSnapshot[] d) : IDriveSource
    {
        public IReadOnlyList<DriveSnapshot> Read() => d;
    }

    private sealed class FakeNics : INetworkSource
    {
        public List<NicCounters> Next = [];
        public IReadOnlyList<NicCounters> Read() => Next;
    }

    private sealed class FakeCpu(double? v) : ICpuSource
    {
        public double? ReadUtilizationPercent() => v;
    }

    [Fact]
    public async Task Bellek_kullanim_yuzdesi_hesaplanir()
    {
        var m = await new MemoryCollector(new FakeMem(1000, 250)).CollectAsync(default);
        Assert.Equal(75.0, m["mem.used_pct"]);
        Assert.Equal(750.0, m["mem.used_bytes"]);
        Assert.Equal(1000.0, m["mem.total_bytes"]);
    }

    [Fact]
    public async Task Bellek_toplam_sifirsa_null_doner()
    {
        var m = await new MemoryCollector(new FakeMem(0, 0)).CollectAsync(default);
        Assert.Null(m["mem.used_pct"]);
    }

    [Fact]
    public async Task Disk_kullanim_yuzdesi_surucu_harfiyle_anahtarlanir()
    {
        var c = new DiskCollector(new FakeDrives(new DriveSnapshot("C", 200, 50), new DriveSnapshot("D", 0, 0)));
        var m = await c.CollectAsync(default);
        Assert.Equal(75.0, m["disk.C.used_pct"]);
        Assert.False(m.ContainsKey("disk.D.used_pct"));
    }

    [Fact]
    public async Task Ag_ilk_olcumde_baseline_alir_metrik_uretmez()
    {
        var src = new FakeNics { Next = [new NicCounters("Ethernet 1", 1000, 2000)] };
        long now = 0;
        var c = new NetworkCollector(src, () => now);
        var m = await c.CollectAsync(default);
        Assert.Empty(m);
    }

    [Fact]
    public async Task Ag_ikinci_olcumde_bayt_farkindan_bps_hesaplar_ve_adi_sanitize_eder()
    {
        var src = new FakeNics { Next = [new NicCounters("Ethernet 1", 1000, 2000)] };
        long now = 0;
        var c = new NetworkCollector(src, () => now);
        await c.CollectAsync(default);

        now = 2000; // ms
        src.Next = [new NicCounters("Ethernet 1", 3000, 2500)];
        var m = await c.CollectAsync(default);

        Assert.Equal(1000.0, m["net.Ethernet_1.rx_bps"]); // 2000 bayt / 2 sn
        Assert.Equal(250.0, m["net.Ethernet_1.tx_bps"]);  // 500 bayt / 2 sn
    }

    [Fact]
    public async Task Ag_sayaci_geri_giderse_yeniden_baseline_alir()
    {
        var src = new FakeNics { Next = [new NicCounters("e0", 5000, 5000)] };
        long now = 0;
        var c = new NetworkCollector(src, () => now);
        await c.CollectAsync(default);
        now = 1000;
        src.Next = [new NicCounters("e0", 100, 100)];
        var m = await c.CollectAsync(default);
        Assert.Empty(m);
    }

    [Fact]
    public async Task Cpu_degeri_100e_kirpilir_ve_null_korunur()
    {
        Assert.Equal(100.0, (await new CpuCollector(new FakeCpu(130.4)).CollectAsync(default))["cpu.total"]);
        Assert.Null((await new CpuCollector(new FakeCpu(null)).CollectAsync(default))["cpu.total"]);
        Assert.Equal(12.5, (await new CpuCollector(new FakeCpu(12.5)).CollectAsync(default))["cpu.total"]);
    }
}
