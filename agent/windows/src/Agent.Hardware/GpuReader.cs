namespace SysMon.Agent.Hardware;

public enum GpuReadStatus { Ok, TimedOut, Failed }

public sealed record GpuReadResult(GpuSample Sample, GpuReadStatus Status);

/// <summary>
/// Saglayici okumasini zaman asimiyla sarar: NVML surucu reset'inde bloklanabilir ve token'i yok sayabilir;
/// agent kilitlenmemeli. Zaman asimi/hata bos ornek + durum doner; cagiranin iptali OperationCanceledException olarak yayilir.
/// Not: token'i yok sayan bloklu okuma arka planda takili kalabilir (saglayici sorumlulugu: kisa sureli native cagrilar).
/// </summary>
public static class GpuReader
{
    public static async Task<GpuReadResult> ReadAsync(IGpuProvider provider, GpuDevice device, TimeSpan timeout, CancellationToken ct)
    {
        ArgumentOutOfRangeException.ThrowIfLessThanOrEqual(timeout, TimeSpan.Zero);
        ct.ThrowIfCancellationRequested();

        using var linked = CancellationTokenSource.CreateLinkedTokenSource(ct);
        linked.CancelAfter(timeout);
        var read = Task.Run(() => provider.ReadAsync(device, linked.Token), CancellationToken.None);
        var delay = Task.Delay(timeout, ct);

        var done = await Task.WhenAny(read, delay).ConfigureAwait(false);
        ct.ThrowIfCancellationRequested();
        if (done != read)
        {
            _ = read.ContinueWith(t => _ = t.Exception, TaskContinuationOptions.OnlyOnFaulted); // gozlenmeyen hata uyarisi olmasin
            return new GpuReadResult(GpuSample.Unavailable, GpuReadStatus.TimedOut);
        }
        try
        {
            return new GpuReadResult(await read.ConfigureAwait(false), GpuReadStatus.Ok);
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested)
        {
            return new GpuReadResult(GpuSample.Unavailable, GpuReadStatus.TimedOut); // zaman asimi token'i saglayiciyi iptal etti
        }
        catch (Exception)
        {
            return new GpuReadResult(GpuSample.Unavailable, GpuReadStatus.Failed);
        }
    }
}
