using SysMon.Agent.Collectors;

namespace SysMon.Agent.Transport;

/// <summary>
/// Her sampleInterval'de collector'lari calistirir, ornekleri biriktirir ve batchInterval'de
/// spool'a yazar. Iptalde kalan ornekler de yazilir (kayip yok). Collector turu iptal edilmez;
/// her tur collector zaman asimiyla zaten sinirlidir, boylece yarim kalan ornek olmaz.
/// onStatusChange: bir collector'in durumu (ok/mesaj) DEGISTIGINDE bir kez cagrilir; tekrarlayan ayni hata
/// gunlugu doldurmaz. Ilk basarili tur bildirim uretmez (sessiz normal durum).
/// </summary>
public sealed class SamplingPipeline(
    CollectorRunner runner, Spool spool, Func<DateTimeOffset> now, TimeSpan sampleInterval, TimeSpan batchInterval,
    Action<CollectorStatus>? onStatusChange = null)
{
    private readonly Dictionary<string, (bool Ok, string? Message)> _lastStatus = [];

    public async Task RunAsync(CancellationToken ct)
    {
        var buffer = new List<Sample>();
        var lastFlush = now();
        using var timer = new PeriodicTimer(sampleInterval);
        try
        {
            do
            {
                var r = await runner.RunOnceAsync(CancellationToken.None);
                ReportChanges(r.Statuses);
                buffer.Add(new Sample(now(), new Dictionary<string, double?>(r.Metrics)));
                if (now() - lastFlush >= batchInterval)
                {
                    Flush(buffer);
                    lastFlush = now();
                }
            } while (await timer.WaitForNextTickAsync(ct));
        }
        catch (OperationCanceledException)
        {
            // normal kapanis
        }
        finally
        {
            Flush(buffer);
        }
    }

    private void ReportChanges(IReadOnlyList<CollectorStatus> statuses)
    {
        foreach (var s in statuses)
        {
            var known = _lastStatus.TryGetValue(s.Name, out var prev);
            var current = (s.Ok, s.Message);
            if (known ? prev == current : s.Ok) // ilk tur ve saglikli: bildirim yok
            {
                _lastStatus[s.Name] = current;
                continue;
            }
            _lastStatus[s.Name] = current;
            try
            {
                onStatusChange?.Invoke(s);
            }
            catch (Exception)
            {
                // bildirim hatasi ornekleme dongusunu durdurmamali
            }
        }
    }

    private void Flush(List<Sample> buffer)
    {
        if (buffer.Count == 0) return;
        spool.Enqueue(buffer.ToArray());
        buffer.Clear();
    }
}
