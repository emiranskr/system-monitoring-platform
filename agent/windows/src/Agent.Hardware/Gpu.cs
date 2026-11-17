namespace SysMon.Agent.Hardware;

/// <summary>Bir fiziksel GPU. <see cref="CanonicalId"/> kalici kimliktir (NVML UUID veya PCI konumu); PDH LUID kimlik OLAMAZ.</summary>
public sealed record GpuDevice(string CanonicalId, string Vendor, string Name, string ProviderId);

/// <summary>
/// Tek okuma. Tum alanlar nullable: null = "desteklenmiyor/okunamadi", sifir DEGILDIR.
/// Birimler sabit: yuzde 0-100, bayt, derece C, watt, MHz.
/// </summary>
public sealed record GpuSample(
    double? UtilPct = null,
    long? VramUsedBytes = null,
    long? VramTotalBytes = null,
    double? TempC = null,
    double? PowerW = null,
    double? FanPct = null,
    double? CoreClockMHz = null,
    double? MemClockMHz = null)
{
    /// <summary>Hicbir alani dolu olmayan ornek (zaman asimi / hata / destek yok).</summary>
    public static GpuSample Unavailable { get; } = new();
}

/// <summary>Bir cihazin saglayici tarafindan sunabildigi alanlar.</summary>
[Flags]
public enum GpuCapabilities
{
    None = 0,
    Utilization = 1,
    Vram = 2,
    Temperature = 4,
    Power = 8,
    Fan = 16,
    CoreClock = 32,
    MemClock = 64,
    All = Utilization | Vram | Temperature | Power | Fan | CoreClock | MemClock,
}

/// <summary>
/// Satici API'sine yalnizca saglayici kodu dokunur; collector/protokol/arayuz yalnizca GpuSample ve GpuCapabilities bilir.
/// Gelecekteki saglayicilar (AMD, Intel, PDH yedek) ayni arayuzu uygular; uyum: GpuProviderConformanceTests.
/// </summary>
public interface IGpuProvider
{
    /// <summary>Kisa, kucuk harf/rakam/alt cizgi kimlik (orn. "nvml").</summary>
    string Id { get; }

    /// <summary>Tekillestirmede buyuk deger kazanir (NVML &gt; digerleri).</summary>
    int Priority { get; }

    /// <summary>Surucu/DLL yoksa veya baslatma basarisizsa false; agent diger metriklerle devam eder.</summary>
    bool IsAvailable();

    /// <summary>Kullanilamayan saglayicida bos liste doner (firlatmaz).</summary>
    Task<IReadOnlyList<GpuDevice>> DiscoverAsync(CancellationToken ct);

    /// <summary>Iptal edilmis token ile OperationCanceledException firlatir.</summary>
    Task<GpuSample> ReadAsync(GpuDevice device, CancellationToken ct);

    GpuCapabilities Capabilities(GpuDevice device);
}
