using System.Globalization;
using System.Text.RegularExpressions;

namespace SysMon.Agent.Hardware;

/// <summary>
/// Kalici GPU kimligi. Metrik adinin bir parcasi olur ("gpu.&lt;id&gt;.util_pct"), bu yuzden protokoldeki segment kuralina
/// ([A-Za-z0-9_-:], nokta yok) ve 64 karakter sinirina uymali: "gpu." + id + ".vram_used_bytes" (16) &lt;= 64 =&gt; id &lt;= 44.
/// </summary>
public static partial class GpuCanonicalId
{
    public const int MaxLength = 44;

    [GeneratedRegex(@"^[A-Za-z0-9\-:]+$")]
    private static partial Regex SafeChars();

    [GeneratedRegex(@"^GPU-[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")]
    private static partial Regex NvmlUuid();

    /// <summary>PDH LUID ("luid_0x..._phys_0") gibi yeniden baslatmada degisen veya guvensiz degerler gecersizdir.</summary>
    public static bool IsValid(string? id) =>
        !string.IsNullOrEmpty(id) && id.Length <= MaxLength && SafeChars().IsMatch(id);

    public static string FromNvmlUuid(string uuid)
    {
        if (uuid is null || !NvmlUuid().IsMatch(uuid))
            throw new ArgumentException("gecersiz NVML GPU UUID", nameof(uuid));
        return uuid.ToLowerInvariant();
    }

    public static string FromPci(int domain, int bus, int device, int function)
    {
        ArgumentOutOfRangeException.ThrowIfNegative(domain);
        ArgumentOutOfRangeException.ThrowIfGreaterThan(domain, 0xFFFF);
        ArgumentOutOfRangeException.ThrowIfNegative(bus);
        ArgumentOutOfRangeException.ThrowIfGreaterThan(bus, 0xFF);
        ArgumentOutOfRangeException.ThrowIfNegative(device);
        ArgumentOutOfRangeException.ThrowIfGreaterThan(device, 0x1F);
        ArgumentOutOfRangeException.ThrowIfNegative(function);
        ArgumentOutOfRangeException.ThrowIfGreaterThan(function, 7);
        var ci = CultureInfo.InvariantCulture;
        return $"pci-{domain.ToString("x4", ci)}-{bus.ToString("x2", ci)}-{device.ToString("x2", ci)}-{function.ToString("x1", ci)}";
    }
}
