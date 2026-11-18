using SysMon.Agent.Collectors;

namespace SysMon.Agent.Hardware;

/// <summary>
/// GPU metriklerini mevcut ICollector hattina baglar. Metrik adi: <c>gpu.&lt;CanonicalId&gt;.&lt;alan&gt;</c>
/// (util_pct, vram_used_bytes, vram_total_bytes, temp_c, power_w, fan_pct, core_clock_mhz, mem_clock_mhz).
/// Kurallar: yetenegi OLMAYAN alan hic yayinlanmaz; yetenegi olup bu orneklemede okunamayan alan null olur (kullanilamiyor,
/// sifir degil). Saglayici yok/kullanilamiyor -> bos sonuc, agent diger metriklerle surer. Okuma zaman asimli (GpuReader).
/// Kesif: baslangicta, GPU yokken <c>rediscovery</c> araligiyla ve bir okuma basarisiz olunca bir sonraki turda HEMEN yenilenir.
/// </summary>
public sealed class GpuCollector : ICollector
{
    private readonly IReadOnlyList<IGpuProvider> _providers;
    private readonly TimeSpan _readTimeout;
    private readonly TimeSpan _rediscovery;
    private readonly Func<DateTimeOffset> _clock;

    private IReadOnlyList<MergedGpu> _devices = [];
    private DateTimeOffset _lastDiscovery = DateTimeOffset.MinValue;
    private bool _needsRediscovery = true;

    public GpuCollector(IReadOnlyList<IGpuProvider> providers, TimeSpan interval, TimeSpan readTimeout, TimeSpan rediscoveryInterval, Func<DateTimeOffset>? clock = null)
    {
        _providers = providers;
        Interval = interval;
        _readTimeout = readTimeout;
        _rediscovery = rediscoveryInterval;
        _clock = clock ?? (() => DateTimeOffset.UtcNow);
    }

    public string Name => "gpu";
    public TimeSpan Interval { get; }

    public async Task<IReadOnlyDictionary<string, double?>> CollectAsync(CancellationToken ct)
    {
        var result = new Dictionary<string, double?>();
        if (_needsRediscovery || _clock() - _lastDiscovery >= _rediscovery) await DiscoverAsync(ct).ConfigureAwait(false);

        foreach (var m in _devices)
        {
            var caps = m.Provider.Capabilities(m.Device);
            var r = await GpuReader.ReadAsync(m.Provider, m.Device, _readTimeout, ct).ConfigureAwait(false);
            if (r.Status != GpuReadStatus.Ok) _needsRediscovery = true; // kayip/takilma: bir sonraki turda yeniden kesfet

            var id = m.Device.CanonicalId;
            void Put(GpuCapabilities cap, string field, double? value)
            {
                if (caps.HasFlag(cap)) result[$"gpu.{id}.{field}"] = value;
            }
            var s = r.Sample;
            Put(GpuCapabilities.Utilization, "util_pct", s.UtilPct);
            Put(GpuCapabilities.Vram, "vram_used_bytes", s.VramUsedBytes);
            Put(GpuCapabilities.Vram, "vram_total_bytes", s.VramTotalBytes);
            Put(GpuCapabilities.Temperature, "temp_c", s.TempC);
            Put(GpuCapabilities.Power, "power_w", s.PowerW);
            Put(GpuCapabilities.Fan, "fan_pct", s.FanPct);
            Put(GpuCapabilities.CoreClock, "core_clock_mhz", s.CoreClockMHz);
            Put(GpuCapabilities.MemClock, "mem_clock_mhz", s.MemClockMHz);
        }
        return result;
    }

    private async Task DiscoverAsync(CancellationToken ct)
    {
        var found = new List<(IGpuProvider, IReadOnlyList<GpuDevice>)>();
        var failed = false;
        foreach (var p in _providers)
        {
            try
            {
                if (!p.IsAvailable()) continue;
                found.Add((p, await p.DiscoverAsync(ct).ConfigureAwait(false)));
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested) { throw; }
            catch (Exception) { failed = true; /* saglayici hatasi digerlerini ve agent'i etkilemez */ }
        }
        if (failed)
        {
            // Gecici hata (orn. Busy): eksik/bos kesif sonucu eski listeyi SILMEZ; bir sonraki turda hemen yeniden denenir.
            _needsRediscovery = true;
            return;
        }
        _devices = GpuDeduplicator.Merge(found);
        _lastDiscovery = _clock();
        _needsRediscovery = false;
    }
}
