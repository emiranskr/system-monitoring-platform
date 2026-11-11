using SysMon.Agent.Collectors;

namespace SysMon.Agent.Transport;

/// <summary>
/// Her sampleInterval'de collector'lari calistirir, ornekleri biriktirir ve batchInterval'de
/// spool'a yazar. Iptalde kalan ornekler de yazilir (kayip yok). Collector turu iptal edilmez;
/// her tur collector zaman asimiyla zaten sinirlidir, boylece yarim kalan ornek olmaz.
/// </summary>
public sealed class SamplingPipeline(
    CollectorRunner runner, Spool spool, Func<DateTimeOffset> now, TimeSpan sampleInterval, TimeSpan batchInterval)
{
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

    private void Flush(List<Sample> buffer)
    {
        if (buffer.Count == 0) return;
        spool.Enqueue(buffer.ToArray());
        buffer.Clear();
    }
}
