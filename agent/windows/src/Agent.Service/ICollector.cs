namespace SysMon.Agent;

/// <summary>Bir metrik kaynagi. Deger null ise "desteklenmiyor/kullanilamiyor" demektir.</summary>
public interface ICollector
{
    string Name { get; }
    TimeSpan Interval { get; }
    Task<IReadOnlyDictionary<string, double?>> CollectAsync(CancellationToken ct);
}
