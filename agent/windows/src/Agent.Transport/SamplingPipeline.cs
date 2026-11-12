using SysMon.Agent.Collectors;

namespace SysMon.Agent.Transport;

/// <summary>
/// Her sampleInterval'de collector'lari calistirir, ornekleri biriktirir ve batchInterval'de
/// sink'e (spool) yazar. Iptalde kalan ornekler de yazilir (kayip yok). Collector turu iptal edilmez;
/// her tur collector zaman asimiyla zaten sinirlidir, boylece yarim kalan ornek olmaz.
/// onStatusChange: bir collector'in durumu DEGISTIGINDE bir kez cagrilir (tekrarlayan ayni hata gunlugu doldurmaz).
/// YAZMA HATASI (disk dolu vb.) hattin ve dolayisiyla servisin dusmesine yol acmaz: ornekler tamponda tutulur
/// ve sonraki flush'ta tekrar denenir; tampon maxBufferedSamples ile sinirlidir (asilirsa EN ESKI ornekler atilir
/// ve DroppedSamples ile sayilir). Hata onError ile bildirilir.
/// </summary>
public sealed class SamplingPipeline(
    CollectorRunner runner, IBatchSink sink, Func<DateTimeOffset> now, TimeSpan sampleInterval, TimeSpan batchInterval,
    Action<CollectorStatus>? onStatusChange = null, Action<Exception>? onError = null, int maxBufferedSamples = 20_000,
    SamplingConfig? sampling = null)
{
    private readonly Dictionary<string, (bool Ok, string? Message)> _lastStatus = [];
    private readonly List<Sample> _buffer = [];

    public long DroppedSamples { get; private set; }

    public int BufferedSamples => _buffer.Count;

    public async Task RunAsync(CancellationToken ct)
    {
        var lastFlush = now();
        using var timer = new PeriodicTimer(sampleInterval);
        try
        {
            do
            {
                if (sampling is not null && timer.Period != sampling.Interval) timer.Period = sampling.Interval; // sunucu degistirdiyse bir sonraki tikten itibaren
                var r = await runner.RunOnceAsync(CancellationToken.None);
                ReportChanges(r.Statuses);
                _buffer.Add(new Sample(now(), new Dictionary<string, double?>(r.Metrics)));
                LimitBuffer();
                if (now() - lastFlush >= batchInterval)
                {
                    Flush();
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
            Flush();
        }
    }

    private void LimitBuffer()
    {
        var excess = _buffer.Count - maxBufferedSamples;
        if (excess <= 0) return;
        _buffer.RemoveRange(0, excess);
        DroppedSamples += excess;
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

    private void Flush()
    {
        if (_buffer.Count == 0) return;
        try
        {
            sink.Enqueue(_buffer.ToArray());
            _buffer.Clear();
        }
        catch (Exception ex)
        {
            // Ornekler tamponda kalir, sonraki flush'ta tekrar denenir.
            try { onError?.Invoke(ex); }
            catch (Exception) { /* bildirim hatasi hatti durdurmaz */ }
        }
    }
}
