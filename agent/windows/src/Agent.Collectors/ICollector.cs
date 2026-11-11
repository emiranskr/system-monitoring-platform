using System.Text.RegularExpressions;

namespace SysMon.Agent.Collectors;

/// <summary>Bir metrik kaynagi. Deger null ise "desteklenmiyor/kullanilamiyor" demektir.</summary>
public interface ICollector
{
    string Name { get; }
    TimeSpan Interval { get; }
    Task<IReadOnlyDictionary<string, double?>> CollectAsync(CancellationToken ct);
}

public sealed record CollectorStatus(string Name, bool Ok, string? Message = null);

public sealed record CollectionResult(
    IReadOnlyDictionary<string, double?> Metrics,
    IReadOnlyList<CollectorStatus> Statuses);

/// <summary>Protokoldaki METRIC_NAME_RE ile ayni kural (packages/protocol).</summary>
public static partial class MetricNames
{
    [GeneratedRegex(@"^[a-z0-9_]+(\.[A-Za-z0-9_\-:]+){1,3}$")]
    private static partial Regex Pattern();

    public static bool IsValid(string name) => name.Length <= 64 && Pattern().IsMatch(name);

    /// <summary>Adaptor/disk adlarini metrik anahtarinda guvenli bir kimlige cevirir.</summary>
    public static string Sanitize(string id)
    {
        var s = Regex.Replace(id, @"[^A-Za-z0-9_\-]", "_");
        return s.Length > 32 ? s[..32] : s;
    }
}
