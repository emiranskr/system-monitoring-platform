using SysMon.Agent.Hardware;

namespace Agent.Tests.Hardware;

public class GpuReaderTests
{
    private static readonly GpuDevice D = new("gpu-a", "V", "GPU", "fake");

    [Fact]
    public async Task Basarili_okuma_ornegi_ve_Ok_durumunu_doner()
    {
        var p = new FakeGpuProvider("fake", 1, [D]) { Sample = new GpuSample(UtilPct: 12.5, TempC: 50) };
        var r = await GpuReader.ReadAsync(p, D, TimeSpan.FromSeconds(1), CancellationToken.None);
        Assert.Equal(GpuReadStatus.Ok, r.Status);
        Assert.Equal(12.5, r.Sample.UtilPct);
    }

    [Fact]
    public async Task Tokeni_yok_sayan_bloklu_saglayici_zaman_asiminda_TimedOut_ve_bos_ornek_doner()
    {
        var p = new FakeGpuProvider("fake", 1, [D]) { BlockForever = true, IgnoreToken = true };
        var sw = System.Diagnostics.Stopwatch.StartNew();
        var r = await GpuReader.ReadAsync(p, D, TimeSpan.FromMilliseconds(150), CancellationToken.None);
        Assert.Equal(GpuReadStatus.TimedOut, r.Status);
        Assert.Equal(GpuSample.Unavailable, r.Sample);
        Assert.True(sw.Elapsed < TimeSpan.FromSeconds(2), $"agent kilitlendi: {sw.Elapsed}");
    }

    [Fact]
    public async Task Saglayici_firlatirsa_Failed_doner_ve_firlatmaz()
    {
        var p = new FakeGpuProvider("fake", 1, [D]) { ThrowOnRead = new InvalidOperationException("NVML_ERROR_GPU_IS_LOST") };
        var r = await GpuReader.ReadAsync(p, D, TimeSpan.FromSeconds(1), CancellationToken.None);
        Assert.Equal(GpuReadStatus.Failed, r.Status);
        Assert.Equal(GpuSample.Unavailable, r.Sample);
    }

    [Fact]
    public async Task Cagiranin_iptali_OperationCanceledException_olarak_yayilir()
    {
        var p = new FakeGpuProvider("fake", 1, [D]) { BlockForever = true };
        using var cts = new CancellationTokenSource(50);
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => GpuReader.ReadAsync(p, D, TimeSpan.FromSeconds(5), cts.Token));
    }

    [Fact]
    public async Task Sifir_veya_negatif_zaman_asimi_reddedilir()
    {
        var p = new FakeGpuProvider("fake", 1, [D]);
        await Assert.ThrowsAsync<ArgumentOutOfRangeException>(() => GpuReader.ReadAsync(p, D, TimeSpan.Zero, CancellationToken.None));
    }
}
