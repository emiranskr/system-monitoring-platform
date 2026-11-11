namespace SysMon.Agent.Transport;

/// <summary>
/// Yukleme dongusu: adim sonucuna gore bekler. Beklenmeyen bir istisna dongunun (ve servisin) dusmesine
/// yol acmaz: Retry gibi geri cekilmeyle beklenir ve onUnexpected ile bildirilir. Iptalde istisna firlatmaz.
/// AuthFailed (401/403) dongu SONLANDIRMAZ: token sonradan iceri aktarilabilir/degisebilir; Backoff.Cap (5 dk)
/// aralikla yeniden denenir (iptal edilmis cihaz sunucuyu en fazla 5 dakikada bir yoklar).
/// </summary>
public sealed class UploadRunner(
    Func<CancellationToken, Task<UploadOutcome>> step,
    Func<TimeSpan, CancellationToken, Task> delay,
    Random rnd,
    Action<UploadOutcome, TimeSpan>? onWait = null,
    Action<Exception>? onUnexpected = null)
{
    public async Task RunAsync(CancellationToken ct)
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
                    return;
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
                    case UploadOutcome.Idle:
                        attempt = 0;
                        wait = TimeSpan.FromSeconds(1);
                        break;
                    case UploadOutcome.TlsRejected:
                    case UploadOutcome.AuthFailed:
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
                return;
            }
        }
    }

    private static void SafeInvoke(Action a)
    {
        try { a(); } catch (Exception) { /* bildirim hatasi dongu durdurmaz */ }
    }
}
