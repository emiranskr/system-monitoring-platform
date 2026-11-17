using SysMon.Agent.Hardware;

namespace Agent.Tests.Hardware;

public class GpuDeduplicatorTests
{
    private static GpuDevice Dev(string id, string provider, string name = "GPU") => new(id, "V", name, provider);

    [Fact]
    public void Ayni_fiziksel_GPU_iki_saglayicida_gelirse_oncelikli_saglayici_kazanir()
    {
        var nvml = new FakeGpuProvider("nvml", 100, [Dev("pci-0000-01-00-0", "nvml", "RTX")]);
        var pdh = new FakeGpuProvider("pdh", 10, [Dev("pci-0000-01-00-0", "pdh", "RTX (pdh)")]);

        // sira (pdh once) sonucu degistirmemeli
        var merged = GpuDeduplicator.Merge([(pdh, pdh.Devices), (nvml, nvml.Devices)]);

        var only = Assert.Single(merged);
        Assert.Equal("nvml", only.Provider.Id);
        Assert.Equal("RTX", only.Device.Name);
    }

    [Fact]
    public void Farkli_GPUlar_birlikte_kalir_ve_CanonicalId_ile_sirali_doner()
    {
        var a = new FakeGpuProvider("nvml", 100, [Dev("gpu-b", "nvml")]);
        var b = new FakeGpuProvider("pdh", 10, [Dev("gpu-a", "pdh")]);

        var merged = GpuDeduplicator.Merge([(a, a.Devices), (b, b.Devices)]);

        Assert.Equal(["gpu-a", "gpu-b"], merged.Select(m => m.Device.CanonicalId).ToArray());
    }

    [Fact]
    public void Esit_oncelikte_ilk_gelen_kazanir_deterministik()
    {
        var a = new FakeGpuProvider("p1", 50, [Dev("gpu-x", "p1")]);
        var b = new FakeGpuProvider("p2", 50, [Dev("gpu-x", "p2")]);

        Assert.Equal("p1", Assert.Single(GpuDeduplicator.Merge([(a, a.Devices), (b, b.Devices)])).Provider.Id);
        Assert.Equal("p2", Assert.Single(GpuDeduplicator.Merge([(b, b.Devices), (a, a.Devices)])).Provider.Id);
    }

    [Fact]
    public void Gecersiz_CanonicalId_ve_ayni_saglayicidaki_tekrarlar_atlanir()
    {
        var p = new FakeGpuProvider("nvml", 100, [Dev("luid_0x1_phys_0", "nvml"), Dev("gpu-a", "nvml", "ilk"), Dev("gpu-a", "nvml", "ikinci")]);

        var only = Assert.Single(GpuDeduplicator.Merge([(p, p.Devices)]));
        Assert.Equal("ilk", only.Device.Name);
    }

    [Fact]
    public void Bos_girdi_bos_doner()
    {
        Assert.Empty(GpuDeduplicator.Merge([]));
    }
}
