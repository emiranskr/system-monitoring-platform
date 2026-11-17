namespace SysMon.Agent.Hardware;

public sealed record MergedGpu(GpuDevice Device, IGpuProvider Provider);

/// <summary>Ayni fiziksel GPU'yu birden cok saglayici listelerse CanonicalId'ye gore tekillestirir; yuksek Priority kazanir.</summary>
public static class GpuDeduplicator
{
    /// <summary>
    /// Sonuc CanonicalId'ye gore (ordinal) sirali ve deterministiktir. Esit oncelikte girdideki ilk saglayici kazanir.
    /// Gecersiz CanonicalId'li cihazlar (orn. PDH LUID) ve ayni saglayicidaki tekrarlar atlanir.
    /// </summary>
    public static IReadOnlyList<MergedGpu> Merge(IEnumerable<(IGpuProvider Provider, IReadOnlyList<GpuDevice> Devices)> discovered)
    {
        var best = new Dictionary<string, MergedGpu>(StringComparer.Ordinal);
        foreach (var (provider, devices) in discovered)
        {
            var seen = new HashSet<string>(StringComparer.Ordinal);
            foreach (var d in devices)
            {
                if (!GpuCanonicalId.IsValid(d.CanonicalId) || !seen.Add(d.CanonicalId)) continue;
                if (!best.TryGetValue(d.CanonicalId, out var cur) || provider.Priority > cur.Provider.Priority)
                    best[d.CanonicalId] = new MergedGpu(d, provider);
            }
        }
        return best.Values.OrderBy(m => m.Device.CanonicalId, StringComparer.Ordinal).ToList();
    }
}
