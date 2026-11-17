using SysMon.Agent.Hardware;

namespace Agent.Tests.Hardware;

public class GpuCanonicalIdTests
{
    [Fact]
    public void NvmlUuid_kucuk_harfe_cevrilir_ve_metrik_anahtari_icin_gecerlidir()
    {
        var id = GpuCanonicalId.FromNvmlUuid("GPU-46139694-B075-6C98-9B95-3B6F3A465823");
        Assert.Equal("gpu-46139694-b075-6c98-9b95-3b6f3a465823", id);
        Assert.True(GpuCanonicalId.IsValid(id));
    }

    [Theory]
    [InlineData("")]
    [InlineData("GPU-xyz")]
    [InlineData("MIG-46139694-b075-6c98-9b95-3b6f3a465823")]
    [InlineData("GPU-46139694-b075-6c98-9b95-3b6f3a46582")]            // 1 hane eksik
    [InlineData("GPU-46139694-b075-6c98-9b95-3b6f3a465823/../x")]
    public void NvmlUuid_gecersiz_girdi_reddedilir(string uuid)
    {
        Assert.Throws<ArgumentException>(() => GpuCanonicalId.FromNvmlUuid(uuid));
    }

    [Fact]
    public void Pci_konumu_sabit_bicimde_kimlik_uretir()
    {
        Assert.Equal("pci-0000-01-00-0", GpuCanonicalId.FromPci(0, 1, 0, 0));
        Assert.Equal("pci-0001-ab-1f-7", GpuCanonicalId.FromPci(1, 0xab, 0x1f, 7));
    }

    [Theory]
    [InlineData(-1, 0, 0, 0)]
    [InlineData(0, 256, 0, 0)]
    [InlineData(0, 0, 32, 0)]
    [InlineData(0, 0, 0, 8)]
    public void Pci_aralik_disi_reddedilir(int domain, int bus, int dev, int fn)
    {
        Assert.Throws<ArgumentOutOfRangeException>(() => GpuCanonicalId.FromPci(domain, bus, dev, fn));
    }

    [Theory]
    [InlineData("luid_0x00000000_0x0000d525_phys_0")]   // PDH LUID kimlik OLAMAZ (yeniden baslatmada degisir)
    [InlineData("has space")]
    [InlineData("ÜNİKOD")]
    [InlineData("a.b")]                                  // '.' metrik anahtarinda ayirici
    public void IsValid_LUID_ve_guvensiz_karakterleri_reddeder(string id)
    {
        Assert.False(GpuCanonicalId.IsValid(id));
    }

    [Fact]
    public void IsValid_uzunluk_siniri_metrik_adi_64_karakteri_asmaz()
    {
        // "gpu." + id + ".vram_used_bytes" (16) <= 64  =>  id <= 44
        Assert.True(GpuCanonicalId.IsValid(new string('a', 44)));
        Assert.False(GpuCanonicalId.IsValid(new string('a', 45)));
        Assert.False(GpuCanonicalId.IsValid(""));
    }
}
