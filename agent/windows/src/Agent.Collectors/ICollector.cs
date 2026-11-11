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

    /// <summary>
    /// Adaptor/disk adini metrik anahtari icin guvenli kimlige cevirir. Cevirme KAYIPLIYSA (ASCII disi karakter,
    /// bosluk, kesme) ayirt edici bir ek (adin SHA-256 ilk 4 hex'i) eklenir: farkli adlar ayni anahtara dusmez (inceleme O6).
    /// Kayipsiz adlar (orn. 'Ethernet') degismez.
    /// </summary>
    public static string SanitizeUnique(string id)
    {
        // Yalniz ASCII disi karakter icerenler belirsizlesir (orn. Ağ / Aş ikisi de A_); bosluk gibi zararsiz donusumler eski anahtari korur.
        if (id.All(ch => ch < 128)) return Sanitize(id);
        var hash = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(id)))[..4].ToLowerInvariant();
        var head = Regex.Replace(id, @"[^A-Za-z0-9_-]", "_");
        if (head.Length > 27) head = head[..27];
        return head + "-" + hash;
    }

    /// <summary>Adaptor/disk adlarini metrik anahtarinda guvenli bir kimlige cevirir.</summary>
    public static string Sanitize(string id)
    {
        var s = Regex.Replace(id, @"[^A-Za-z0-9_\-]", "_");
        return s.Length > 32 ? s[..32] : s;
    }
}
