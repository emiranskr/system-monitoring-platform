namespace SysMon.Agent.Collectors;

public sealed record MemoryInfo(ulong TotalBytes, ulong AvailableBytes);
public interface IMemoryInfoSource { MemoryInfo Read(); }

public sealed class MemoryCollector(IMemoryInfoSource source) : ICollector
{
    public string Name => "memory";
    public TimeSpan Interval => TimeSpan.FromSeconds(1);

    public Task<IReadOnlyDictionary<string, double?>> CollectAsync(CancellationToken ct)
    {
        var m = source.Read();
        var d = new Dictionary<string, double?>();
        if (m.TotalBytes == 0)
        {
            d["mem.used_pct"] = null;
            d["mem.used_bytes"] = null;
            d["mem.total_bytes"] = null;
        }
        else
        {
            var used = m.TotalBytes - Math.Min(m.AvailableBytes, m.TotalBytes);
            d["mem.used_pct"] = used * 100.0 / m.TotalBytes;
            d["mem.used_bytes"] = used;
            d["mem.total_bytes"] = m.TotalBytes;
        }
        return Task.FromResult<IReadOnlyDictionary<string, double?>>(d);
    }
}

public sealed record DriveSnapshot(string Letter, long TotalBytes, long FreeBytes);
public interface IDriveSource { IReadOnlyList<DriveSnapshot> Read(); }

public sealed class DiskCollector(IDriveSource source) : ICollector
{
    public string Name => "disk";
    public TimeSpan Interval => TimeSpan.FromSeconds(5);

    public Task<IReadOnlyDictionary<string, double?>> CollectAsync(CancellationToken ct)
    {
        var d = new Dictionary<string, double?>();
        foreach (var drv in source.Read())
        {
            if (drv.TotalBytes <= 0) continue;
            d[$"disk.{MetricNames.Sanitize(drv.Letter)}.used_pct"] =
                (drv.TotalBytes - drv.FreeBytes) * 100.0 / drv.TotalBytes;
        }
        return Task.FromResult<IReadOnlyDictionary<string, double?>>(d);
    }
}

public sealed record NicCounters(string Id, ulong RxBytes, ulong TxBytes);
public interface INetworkSource { IReadOnlyList<NicCounters> Read(); }

/// <summary>Sayac farklarindan bayt/sn hesaplar. Ilk olcum yalnizca baseline alir; sayac geri giderse yeniden baseline alir.</summary>
public sealed class NetworkCollector(INetworkSource source, Func<long> nowMs) : ICollector
{
    private readonly Dictionary<string, (ulong rx, ulong tx, long t)> _prev = [];

    public string Name => "network";
    public TimeSpan Interval => TimeSpan.FromSeconds(1);

    public Task<IReadOnlyDictionary<string, double?>> CollectAsync(CancellationToken ct)
    {
        var d = new Dictionary<string, double?>();
        var now = nowMs();
        foreach (var nic in source.Read())
        {
            var key = MetricNames.SanitizeUnique(nic.Id);
            if (_prev.TryGetValue(key, out var p) && now > p.t && nic.RxBytes >= p.rx && nic.TxBytes >= p.tx)
            {
                var secs = (now - p.t) / 1000.0;
                d[$"net.{key}.rx_bps"] = (nic.RxBytes - p.rx) / secs;
                d[$"net.{key}.tx_bps"] = (nic.TxBytes - p.tx) / secs;
            }
            _prev[key] = (nic.RxBytes, nic.TxBytes, now);
        }
        return Task.FromResult<IReadOnlyDictionary<string, double?>>(d);
    }
}

public interface ICpuSource
{
    double? ReadUtilizationPercent();

    /// <summary>Kaynak baslatilamadiysa/okunamiyorsa neden; aksi halde null.</summary>
    string? Error => null;
}

public sealed class CpuCollector(ICpuSource source) : ICollector
{
    public string Name => "cpu";
    public TimeSpan Interval => TimeSpan.FromSeconds(1);

    public Task<IReadOnlyDictionary<string, double?>> CollectAsync(CancellationToken ct)
    {
        // "% Processor Utility" turbo nedeniyle 100'u asabilir; Gorev Yoneticisi gibi 100'e kirpilir.
        var v = source.ReadUtilizationPercent();
        // Kaynak kullanilamiyorsa (ornegin sayac erisimi yok) metrik uretme; runner bunu collector_status hatasi olarak raporlar.
        if (v is null && source.Error is { } err) throw new InvalidOperationException(err);
        var d = new Dictionary<string, double?> { ["cpu.total"] = v is null ? null : Math.Clamp(v.Value, 0, 100) };
        return Task.FromResult<IReadOnlyDictionary<string, double?>>(d);
    }
}
