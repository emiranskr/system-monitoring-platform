namespace SysMon.Agent.Transport;

/// <summary>Kumulatif kayip sayaclari (agent baslangicindan beri).</summary>
public readonly record struct LossCounters(long DroppedSamples, long RejectedSamples, long DroppedBatches);

/// <summary>
/// Yakalama yolundaki sessiz kayiplari gorunur kilar (inceleme I-3): sayaclar degistiginde BIR uyari (kumulatif degerlerle),
/// tekrarlayan Enqueue hatalari aralik basina tek satir (bastirilan sayisiyla). Log hatasi ornekleme hattini durdurmaz.
/// </summary>
public sealed class LossReporter(
    Func<LossCounters> read, Action<string> warn, Action<Exception, int> error, Func<DateTimeOffset> now, TimeSpan errorInterval)
{
    private readonly object _gate = new();
    private LossCounters _last;
    private DateTimeOffset? _lastErrorAt;
    private int _suppressed;

    public void CheckCounters()
    {
        try
        {
            string? message = null;
            lock (_gate)
            {
                var c = read();
                if (c == _last) return;
                _last = c;
                message = $"Veri kaybi (kumulatif): dusen ornek {c.DroppedSamples}, sunucunun reddettigi ornek {c.RejectedSamples}, dusen batch {c.DroppedBatches}.";
            }
            warn(message);
        }
        catch (Exception) { /* log hatasi hatti durdurmaz */ }
    }

    public void ReportError(Exception ex)
    {
        try
        {
            int suppressed;
            lock (_gate)
            {
                var t = now();
                if (_lastErrorAt is { } last && t - last < errorInterval)
                {
                    _suppressed++;
                    return;
                }
                _lastErrorAt = t;
                suppressed = _suppressed;
                _suppressed = 0;
            }
            error(ex, suppressed);
        }
        catch (Exception) { /* log hatasi hatti durdurmaz */ }
    }
}
