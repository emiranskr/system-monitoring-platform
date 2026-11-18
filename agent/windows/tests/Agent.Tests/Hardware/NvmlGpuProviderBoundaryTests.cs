using SysMon.Agent.Hardware;
using SysMon.Agent.Hardware.Nvml;

namespace Agent.Tests.Hardware;

/// <summary>Bagimsiz inceleme (M4) I-2: sinir degerleri ve her kayip kodu icin kilitleyici testler.</summary>
public class NvmlGpuProviderBoundaryTests
{
    private static async Task<GpuSample> ReadWith(FakeNvmlGpu gpu)
    {
        var api = new FakeNvmlApi();
        api.Gpus.Add(gpu);
        using var p = new NvmlGpuProvider(api);
        var d = Assert.Single(await p.DiscoverAsync(CancellationToken.None));
        return await p.ReadAsync(d, CancellationToken.None);
    }

    [Fact]
    public async Task Sinirdaki_gecerli_degerler_korunur_yuzde_100_sicaklik_200_guc_10kW_saat_100000()
    {
        var s = await ReadWith(new FakeNvmlGpu { Util = 100, FanPct = 100, TempC = 200, PowerMw = 10_000_000, CoreMHz = 100_000, MemMHz = 100_000, Total = 1000, Used = 1000 });
        Assert.Equal(100, s.UtilPct);
        Assert.Equal(100, s.FanPct);
        Assert.Equal(200, s.TempC);
        Assert.Equal(10_000.0, s.PowerW);
        Assert.Equal(100_000, s.CoreClockMHz);
        Assert.Equal(100_000, s.MemClockMHz);
        Assert.Equal(1000L, s.VramUsedBytes);   // used == total: gecerli (VRAM tamamen dolu)
        Assert.Equal(1000L, s.VramTotalBytes);
    }

    [Fact]
    public async Task Sinirin_bir_ustu_null_olur()
    {
        var s = await ReadWith(new FakeNvmlGpu { Util = 101, FanPct = 101, TempC = 201, PowerMw = 10_000_001, CoreMHz = 100_001, MemMHz = 100_001 });
        Assert.Null(s.UtilPct); Assert.Null(s.FanPct); Assert.Null(s.TempC); Assert.Null(s.PowerW); Assert.Null(s.CoreClockMHz); Assert.Null(s.MemClockMHz);
    }

    [Fact]
    public async Task Long_MaxValue_tam_siniri_gecerli_bir_fazlasi_reddedilir()
    {
        var ok = await ReadWith(new FakeNvmlGpu { Total = (ulong)long.MaxValue, Used = 5 });
        Assert.Equal(long.MaxValue, ok.VramTotalBytes);
        Assert.Equal(5L, ok.VramUsedBytes);
        var bad = await ReadWith(new FakeNvmlGpu { Total = (ulong)long.MaxValue + 1, Used = 5 });
        Assert.Null(bad.VramTotalBytes);
    }

    [Theory]
    [InlineData(NvmlStatus.GpuIsLost)]
    [InlineData(NvmlStatus.Uninitialized)]
    [InlineData(NvmlStatus.InvalidArgument)]
    [InlineData(NvmlStatus.ResetRequired)]
    [InlineData(NvmlStatus.DriverNotLoaded)]
    public async Task Her_kayip_durum_kodu_GpuLostException_uretir(NvmlStatus st)
    {
        var api = new FakeNvmlApi();
        var gpu = new FakeNvmlGpu();
        api.Gpus.Add(gpu);
        using var p = new NvmlGpuProvider(api);
        var d = Assert.Single(await p.DiscoverAsync(CancellationToken.None));
        gpu.UtilStatus = st;
        await Assert.ThrowsAsync<GpuLostException>(() => p.ReadAsync(d, CancellationToken.None));
    }

    [Theory]
    [InlineData(NvmlStatus.NotSupported)]
    [InlineData(NvmlStatus.Unknown)]
    [InlineData(NvmlStatus.NoPermission)]
    [InlineData(NvmlStatus.Timeout)]
    public async Task Kayip_olmayan_hata_kodlari_yalniz_alani_null_yapar(NvmlStatus st)
    {
        var api = new FakeNvmlApi();
        var gpu = new FakeNvmlGpu();
        api.Gpus.Add(gpu);
        using var p = new NvmlGpuProvider(api);
        var d = Assert.Single(await p.DiscoverAsync(CancellationToken.None));
        gpu.TempStatus = st;
        var s = await p.ReadAsync(d, CancellationToken.None);
        Assert.Null(s.TempC);
        Assert.Equal(40, s.UtilPct);
    }

    [Fact]
    public void Devre_kesici_bekleme_suresi_TAM_dolunca_yeniden_dener_bir_tik_oncesinde_degil()
    {
        var api = new FakeNvmlApi { InitStatus = NvmlStatus.DriverNotLoaded };
        var t = new DateTimeOffset(2026, 11, 17, 12, 0, 0, TimeSpan.Zero);
        using var p = new NvmlGpuProvider(api, () => t);
        for (var i = 0; i < 3; i++) p.IsAvailable();
        Assert.Equal(3, api.InitCalls);
        t += TimeSpan.FromMinutes(5) - TimeSpan.FromTicks(1);
        p.IsAvailable();
        Assert.Equal(3, api.InitCalls);        // 1 tik erken: hala acik
        t += TimeSpan.FromTicks(1);
        p.IsAvailable();
        Assert.Equal(4, api.InitCalls);        // tam sure dolunca deneme
    }
}
