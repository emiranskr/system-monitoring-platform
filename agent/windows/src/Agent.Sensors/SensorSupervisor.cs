using System.Security.Principal;

namespace SysMon.Agent.Sensors;

/// <summary>Baslatilmis yardimci surec: kimlik + oldurme + cikisi bekleme. Uretimde Process handle'ini tutar.</summary>
public interface IHelperProcess : IHelperIdentity, IAsyncDisposable
{
    void Kill();

    /// <summary>true: surec gercekten cikti (zaman asimina kadar beklenir).</summary>
    Task<bool> WaitForExitAsync(TimeSpan timeout);
}

public interface IHelperLauncher
{
    /// <summary>Yardimciyi verilen pipe adiyla baslatir; hata firlatabilir (supervisor yakalar).</summary>
    IHelperProcess Start(string pipeName);
}

/// <summary>
/// Watchdog ayarlari. Hata sayaci: her baslatma/baglanma/okuma hatasi +1; ardisik <see cref="HealthyReadsToReset"/> basarili
/// okuma sayaci SIFIRLAR (tek basarili okuma sifirlamaz: kararsiz yardimci sonsuz restart dongusune girmesin).
/// Geri cekilme = min(BackoffBase * 2^(hata-1), BackoffMax); hata >= MaxConsecutiveFailures ise devre kesici CircuitCooldown boyunca
/// acik kalir, sonra TEK deneme (yari acik); basarisizsa yeniden acilir.
/// </summary>
public sealed record SupervisorOptions(
    TimeSpan ConnectTimeout, TimeSpan ReadTimeout, TimeSpan BackoffBase, TimeSpan BackoffMax,
    int MaxConsecutiveFailures, TimeSpan CircuitCooldown, int HealthyReadsToReset, TimeSpan KillWait)
{
    public static SupervisorOptions Default { get; } = new(
        ConnectTimeout: TimeSpan.FromSeconds(5), ReadTimeout: TimeSpan.FromSeconds(3),
        BackoffBase: TimeSpan.FromSeconds(5), BackoffMax: TimeSpan.FromMinutes(5),
        MaxConsecutiveFailures: 5, CircuitCooldown: TimeSpan.FromMinutes(10), HealthyReadsToReset: 3, KillWait: TimeSpan.FromSeconds(5));
}

/// <summary>
/// Yardimci surecin yasam dongusu. <see cref="ReadAsync"/> asla yardimci arizasi nedeniyle firlatmaz (yalniz iptal): hata/takilma/
/// baslatilamama durumunda butun sensorler Unavailable doner; agent'in CPU/RAM/GPU izlemesi etkilenmez.
/// Tek ucus (es zamanli okumalar sirayla). Takili/bozuk yardimci OLDURULUR ve cikisi dogrulanmadan yenisi baslatilmaz.
/// Her baslatmada yeni rastgele pipe adi. Hata yoluna girince pipe baglantisi kapatilir (gec yanit karismaz).
/// </summary>
public sealed class SensorSupervisor : IAsyncDisposable
{
    private readonly IHelperLauncher _launcher;
    private readonly SupervisorOptions _opt;
    private readonly Func<DateTimeOffset> _clock;
    private readonly SemaphoreSlim _gate = new(1, 1);

    private IHelperProcess? _process;
    private SensorPipeClient? _client;
    private int _failures;
    private int _healthyStreak;
    private DateTimeOffset _nextAttempt = DateTimeOffset.MinValue;
    private bool _disposed;

    public SensorSupervisor(IHelperLauncher launcher, SupervisorOptions options, Func<DateTimeOffset>? clock = null)
    {
        _launcher = launcher;
        _opt = options;
        _clock = clock ?? (() => DateTimeOffset.UtcNow);
    }

    public int ConsecutiveFailures => Volatile.Read(ref _failures);

    private static IReadOnlyList<SensorReading> Unavailable() =>
        Enum.GetValues<SensorId>().Select(id => new SensorReading(id, SensorStatus.Unavailable, 0.0)).ToList();

    public async Task<IReadOnlyList<SensorReading>> ReadAsync(CancellationToken ct)
    {
        await _gate.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            if (_disposed) return Unavailable();

            // onceki takili/oldurulemeyen surec varsa: once onu bitir, yenisini baslatma
            if (_process is not null && _client is null && !await TryReapAsync().ConfigureAwait(false)) return Unavailable();

            if (_client is null)
            {
                if (_clock() < _nextAttempt) return Unavailable();
                if (!await TryStartAsync(ct).ConfigureAwait(false)) return Unavailable();
            }

            try
            {
                var readings = await _client!.ReadAllAsync(_opt.ReadTimeout, ct).ConfigureAwait(false);
                if (++_healthyStreak >= _opt.HealthyReadsToReset) Volatile.Write(ref _failures, 0);
                return readings;
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested) { throw; }
            catch (Exception)
            {
                await TeardownAsync().ConfigureAwait(false);
                RecordFailure();
                return Unavailable();
            }
        }
        finally { _gate.Release(); }
    }

    private async Task<bool> TryStartAsync(CancellationToken ct)
    {
        var name = SensorPipeServer.NewPipeName();
        try
        {
            _process = _launcher.Start(name);
            _client = await SensorPipeClient.ConnectAsync(name, _process, _opt.ConnectTimeout, ct).ConfigureAwait(false);
            return true;
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            await TeardownAsync().ConfigureAwait(false);
            throw;
        }
        catch (Exception)
        {
            await TeardownAsync().ConfigureAwait(false);
            RecordFailure();
            return false;
        }
    }

    /// <summary>Baglantiyi kapatir, sureci oldurur ve cikisini bekler. Cikis dogrulanamazsa _process tutulur (yeni surec baslatilmaz).</summary>
    private async Task TeardownAsync()
    {
        if (_client is not null)
        {
            try { await _client.DisposeAsync().ConfigureAwait(false); } catch { }
            _client = null;
        }
        _healthyStreak = 0;
        await TryReapAsync().ConfigureAwait(false);
    }

    private async Task<bool> TryReapAsync()
    {
        if (_process is null) return true;
        try
        {
            if (!_process.HasExited) _process.Kill();
        }
        catch { /* zaten cikmis olabilir */ }
        var exited = false;
        try { exited = _process.HasExited || await _process.WaitForExitAsync(_opt.KillWait).ConfigureAwait(false); } catch { }
        if (!exited) return false;
        try { await _process.DisposeAsync().ConfigureAwait(false); } catch { }
        _process = null;
        return true;
    }

    private void RecordFailure()
    {
        var f = ++_failures;
        _healthyStreak = 0;
        var now = _clock();
        if (f >= _opt.MaxConsecutiveFailures) { _nextAttempt = now + _opt.CircuitCooldown; return; }
        var backoff = TimeSpan.FromTicks(Math.Min(_opt.BackoffMax.Ticks, (long)(_opt.BackoffBase.Ticks * Math.Pow(2, f - 1))));
        _nextAttempt = now + backoff;
    }

    public async ValueTask DisposeAsync()
    {
        await _gate.WaitAsync().ConfigureAwait(false);
        try
        {
            if (_disposed) return;
            _disposed = true;
            await TeardownAsync().ConfigureAwait(false);
        }
        finally { _gate.Release(); }
    }
}
