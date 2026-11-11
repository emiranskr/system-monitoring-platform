namespace SysMon.Agent.Collectors;

/// <summary>
/// Collector'lari hata ve zaman asimi izolasyonuyla calistirir. Bir collector'in cokmesi
/// veya takilmasi digerlerini etkilemez; sonuc CollectorStatus olarak raporlanir.
/// Takilan (zaman asimina ugrayan) bir collector'in onceki cagrisi BITMEDEN yenisi baslatilmaz: aksi halde
/// kalici takilma her turda bir is parcacigi/gorev sizdirir ve collector durumu (orn. onceki ornekler) paralel cagrilarla bozulur.
/// Sonlu olmayan sayilar (NaN, +-Infinity) null yapilir: JSON'a yazilamazlar ve sonraki yuklemeyi kalici bozardi.
/// </summary>
public sealed class CollectorRunner(IEnumerable<ICollector> collectors, TimeSpan perCollectorTimeout)
{
    private readonly ICollector[] _collectors = collectors.ToArray();
    private readonly Dictionary<ICollector, Task> _inFlight = [];
    private readonly object _gate = new();

    public async Task<CollectionResult> RunOnceAsync(CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        var results = await Task.WhenAll(_collectors.Select(c => RunOne(c, ct)));

        var metrics = new Dictionary<string, double?>();
        var statuses = new List<CollectorStatus>();
        foreach (var (status, data) in results)
        {
            statuses.Add(status);
            foreach (var kv in data) metrics[kv.Key] = kv.Value;
        }
        ct.ThrowIfCancellationRequested();
        return new CollectionResult(metrics, statuses);
    }

    private async Task<(CollectorStatus, IReadOnlyDictionary<string, double?>)> RunOne(ICollector c, CancellationToken ct)
    {
        var empty = new Dictionary<string, double?>();

        lock (_gate)
        {
            if (_inFlight.TryGetValue(c, out var prev))
            {
                if (!prev.IsCompleted)
                    return (new CollectorStatus(c.Name, false, "onceki cagri hala calisiyor (takildi); yenisi baslatilmadi"), empty);
                _inFlight.Remove(c);
            }
        }

        using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        cts.CancelAfter(perCollectorTimeout);
        Task<IReadOnlyDictionary<string, double?>> task;
        try
        {
            task = Task.Run(() => c.CollectAsync(cts.Token), CancellationToken.None);
        }
        catch (Exception ex)
        {
            return (new CollectorStatus(c.Name, false, ex.Message), empty);
        }
        lock (_gate) _inFlight[c] = task;

        // Iptali yok sayan (bloklanan) collector'a karsi sert zaman asimi.
        var timeout = Task.Delay(perCollectorTimeout, ct);
        var first = await Task.WhenAny(task, timeout);
        if (first != task)
        {
            ct.ThrowIfCancellationRequested();
            _ = task.ContinueWith(t => _ = t.Exception, TaskContinuationOptions.OnlyOnFaulted);
            return (new CollectorStatus(c.Name, false, $"zaman asimi ({perCollectorTimeout.TotalMilliseconds:0} ms)"), empty);
        }

        try
        {
            var data = await task;
            var valid = new Dictionary<string, double?>();
            var invalid = new List<string>();
            foreach (var kv in data)
            {
                if (!MetricNames.IsValid(kv.Key))
                {
                    invalid.Add(kv.Key);
                    continue;
                }
                valid[kv.Key] = kv.Value is { } v && !double.IsFinite(v) ? null : kv.Value;
            }
            return invalid.Count == 0
                ? (new CollectorStatus(c.Name, true), valid)
                : (new CollectorStatus(c.Name, false, $"gecersiz metrik adi: {string.Join(',', invalid)}"), valid);
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            throw;
        }
        catch (OperationCanceledException)
        {
            return (new CollectorStatus(c.Name, false, "zaman asimi (iptal)"), empty);
        }
        catch (Exception ex)
        {
            return (new CollectorStatus(c.Name, false, ex.Message), empty);
        }
    }
}
