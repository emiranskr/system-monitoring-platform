namespace SysMon.Agent.Transport;

/// <summary>
/// Yukleme dongusu: adim sonucuna gore bekler/durur. Beklenmeyen bir istisna dongunun (ve servisin) dusmesine
/// yol acmaz: Retry gibi geri cekilmeyle beklenir ve onUnexpected ile bildirilir. Iptalde istisna firlatmaz.
/// AuthFailed donerse dongu durur (spool korunur) ve AuthFailed doner; iptalde null doner.
/// </summary>
public sealed class UploadRunner(
    Func<CancellationToken, Task<UploadOutcome>> step,
    Func<TimeSpan, CancellationToken, Task> delay,
    Random rnd,
    Action<UploadOutcome, TimeSpan>? onWait = null,
    Action<Exception>? onUnexpected = null)
{
    public async Task<UploadOutcome?> RunAsync(CancellationToken ct)
    {
        var attempt = 0;
        while (!ct.IsCancellationRequested)
        {
            try
            {
                UploadOutcome outcome;
                try
                {
                    outcome = await step(ct);
                }
                catch (OperationCanceledException) when (ct.IsCancellationRequested)
                {
                    return null;
                }
                catch (Exception ex)
                {
                    SafeInvoke(() => onUnexpected?.Invoke(ex));
                    outcome = UploadOutcome.Retry;
                }

                TimeSpan wait;
                switch (outcome)
                {
                    case UploadOutcome.Acked:
                        attempt = 0;
                        continue; // sirada baska batch olabilir: beklemeden devam
                    case UploadOutcome.AuthFailed:
                        return UploadOutcome.AuthFailed;
                    case UploadOutcome.Idle:
                        attempt = 0;
                        wait = TimeSpan.FromSeconds(1);
                        break;
                    case UploadOutcome.TlsRejected:
                        wait = Backoff.Cap;
                        break;
                    default: // Retry
                        wait = Backoff.Next(attempt++, rnd);
                        break;
                }
                SafeInvoke(() => onWait?.Invoke(outcome, wait));
                await delay(wait, ct);
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested)
            {
                return null;
            }
        }
        return null;
    }

    private static void SafeInvoke(Action a)
    {
        try { a(); } catch (Exception) { /* bildirim hatasi dongu durdurmaz */ }
    }
}
