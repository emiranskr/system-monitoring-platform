using SysMon.Agent.Hardware;

namespace Agent.Tests.Hardware;

/// <summary>
/// Saglayici uyum test tabani (proposal 6.2): her IGpuProvider (sahte, NVML, gelecekte PDH/AMD/Intel) bu sozlesmeyi saglar.
/// Gercek saglayici testleri bu sinifi turetip <see cref="Create"/> ile uretir.
/// </summary>
public abstract class GpuProviderConformanceTests
{
    protected abstract IGpuProvider Create();

    [Fact]
    public void Id_bos_degildir_ve_guvenli_karakterlerden_olusur()
    {
        Assert.Matches("^[a-z0-9_]+$", Create().Id);
    }

    [Fact]
    public async Task Kesfedilen_cihazlar_gecerli_ve_benzersiz_CanonicalId_tasir_ve_ProviderId_eslesir()
    {
        var p = Create();
        var devs = await p.DiscoverAsync(CancellationToken.None);
        if (!p.IsAvailable()) { Assert.Empty(devs); return; }
        Assert.All(devs, d =>
        {
            Assert.True(GpuCanonicalId.IsValid(d.CanonicalId), d.CanonicalId);
            Assert.Equal(p.Id, d.ProviderId);
        });
        Assert.Equal(devs.Count, devs.Select(d => d.CanonicalId).Distinct().Count());
    }

    [Fact]
    public async Task Onceden_iptal_edilmis_token_ReadAsync_icinde_OperationCanceledException_uretir()
    {
        var p = Create();
        var devs = await p.DiscoverAsync(CancellationToken.None);
        if (devs.Count == 0) return;
        using var cts = new CancellationTokenSource();
        cts.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => p.ReadAsync(devs[0], cts.Token));
    }

    [Fact]
    public async Task Ornek_alanlari_birim_araliginda_ve_yalniz_desteklenen_yetenekler_dolu()
    {
        var p = Create();
        var devs = await p.DiscoverAsync(CancellationToken.None);
        foreach (var d in devs)
        {
            var s = await p.ReadAsync(d, CancellationToken.None);
            var caps = p.Capabilities(d);
            if (s.UtilPct is { } u) { Assert.InRange(u, 0, 100); Assert.True(caps.HasFlag(GpuCapabilities.Utilization)); }
            if (s.FanPct is { } f) { Assert.InRange(f, 0, 100); Assert.True(caps.HasFlag(GpuCapabilities.Fan)); }
            if (s.VramUsedBytes is { } vu) { Assert.True(vu >= 0); Assert.True(caps.HasFlag(GpuCapabilities.Vram)); }
            if (s.VramTotalBytes is { } vt) { Assert.True(vt >= 0); Assert.True(caps.HasFlag(GpuCapabilities.Vram)); }
            if (s is { VramUsedBytes: { } a, VramTotalBytes: { } b }) Assert.True(a <= b, "kullanilan VRAM toplami asamaz");
            if (s.TempC is { } t) { Assert.InRange(t, -50, 200); Assert.True(caps.HasFlag(GpuCapabilities.Temperature)); }
            if (s.PowerW is { } w) { Assert.True(w >= 0); Assert.True(caps.HasFlag(GpuCapabilities.Power)); }
            if (s.CoreClockMHz is { } c) { Assert.True(c >= 0); Assert.True(caps.HasFlag(GpuCapabilities.CoreClock)); }
            if (s.MemClockMHz is { } m) { Assert.True(m >= 0); Assert.True(caps.HasFlag(GpuCapabilities.MemClock)); }
        }
    }
}

public class FakeGpuProviderConformanceTests : GpuProviderConformanceTests
{
    protected override IGpuProvider Create() => new FakeGpuProvider("fake", 1,
        [new GpuDevice("gpu-46139694-b075-6c98-9b95-3b6f3a465823", "NVIDIA", "Fake", "fake")])
    {
        Sample = new GpuSample(UtilPct: 40, VramUsedBytes: 1_000, VramTotalBytes: 8_000, TempC: 55, PowerW: 90, FanPct: 30, CoreClockMHz: 1800, MemClockMHz: 9000),
    };
}

public class UnavailableFakeGpuProviderConformanceTests : GpuProviderConformanceTests
{
    protected override IGpuProvider Create() => new FakeGpuProvider("fake", 1, [new GpuDevice("gpu-a", "V", "N", "fake")]) { Available = false };
}
