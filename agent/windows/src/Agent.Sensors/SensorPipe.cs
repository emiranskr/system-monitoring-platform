using System.Diagnostics;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using Microsoft.Win32.SafeHandles;

namespace SysMon.Agent.Sensors;

public enum SensorPipeError
{
    NameInUse,               // ayni adli pipe onceden var (squatting): sunucu baslamaz
    CreateFailed,
    ConnectFailed,           // baglanilamadi (ACL reddi, zaman asimi...)
    ServerIdentityMismatch,  // pipe sunucusu beklenen yardimci surec degil: protokol BASLAMADAN kapatildi
    Timeout,
    Busy,                    // ayni istemcide ikinci es zamanli okuma (tek ucus)
    Broken,                  // onceki hata/zaman asimi sonrasi baglanti kullanilamaz; yeniden baglanilmali
}

public sealed class SensorPipeException(SensorPipeError error, Exception? inner = null)
    : Exception($"sensor pipe hatasi: {error}", inner)
{
    public SensorPipeError Error { get; } = error;
}

/// <summary>Baslatilan yardimci surecin kimligi. Uretimde Process HANDLE'i tutulur (PID yeniden kullanimi olamaz).</summary>
public interface IHelperIdentity
{
    int Pid { get; }
    bool HasExited { get; }
}

public sealed class ProcessHelperIdentity(Process process) : IHelperIdentity
{
    public int Pid => process.Id;
    public bool HasExited => process.HasExited;
}

public sealed record PipeAclEntry(SecurityIdentifier Sid, AccessControlType Type, PipeAccessRights Rights);

internal static class PipeNative
{
    [DllImport("kernel32.dll", SetLastError = true)]
    internal static extern bool GetNamedPipeServerProcessId(SafePipeHandle pipe, out uint serverProcessId);

    [DllImport("kernel32.dll", SetLastError = true)]
    internal static extern bool GetNamedPipeClientProcessId(SafePipeHandle pipe, out uint clientProcessId);
}

/// <summary>
/// Yardimci surecin pipe sunucusu. Guvenlik: tahmin edilemez ad (<see cref="NewPipeName"/>), FILE_FLAG_FIRST_PIPE_INSTANCE
/// (ayni ad onceden varsa baslamaz), PIPE_REJECT_REMOTE_CLIENTS (.NET Windows'ta NamedPipeServerStream icin varsayilan olarak
/// ayarlar; bayrak sorgulanamadigindan testle dogrulanamaz, belgelenmistir), ACL yalniz beklenen hesap + SYSTEM (yeni instance
/// olusturma hakki YOK). TEK pipe ornegi baglantilar arasi Disconnect ile yeniden kullanilir (baglanti arasi ad kapma penceresi yok).
/// Isteyen istemci PID'si beklenenden farkliysa (verilmisse) baglanti protokol baslamadan dusurulur.
/// Saglayici cagrisi tek ucustur: takili cagri bitmeden yenisi baslatilmaz; zaman asimi/hata -> tum sensorler ProviderError.
/// </summary>
public sealed class SensorPipeServer : IAsyncDisposable
{
    private readonly string _name;
    private readonly ISensorProvider _provider;
    private readonly SecurityIdentifier _allowed;
    private readonly int? _expectedClientPid;
    private readonly TimeSpan _providerTimeout;
    private NamedPipeServerStream? _stream;
    private Task<IReadOnlyList<SensorReading>>? _inflight;

    public SensorPipeServer(string pipeName, ISensorProvider provider, SecurityIdentifier allowedClient, int? expectedClientPid, TimeSpan providerTimeout)
    {
        _name = pipeName;
        _provider = provider;
        _allowed = allowedClient;
        _expectedClientPid = expectedClientPid;
        _providerTimeout = providerTimeout;
    }

    /// <summary>128 bit rastgelelik; her calistirmada yeni.</summary>
    public static string NewPipeName() => "sysmon-sensors-" + Convert.ToHexString(RandomNumberGenerator.GetBytes(16)).ToLowerInvariant();

    public void Start()
    {
        if (_stream is not null) throw new InvalidOperationException("zaten basladi");
        _stream = CreateStream();
    }

    private NamedPipeServerStream CreateStream()
    {
        var sec = new PipeSecurity();
        sec.AddAccessRule(new PipeAccessRule(_allowed, PipeAccessRights.ReadWrite | PipeAccessRights.Synchronize, AccessControlType.Allow));
        sec.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null), PipeAccessRights.FullControl, AccessControlType.Allow));
        try
        {
            return NamedPipeServerStreamAcl.Create(_name, PipeDirection.InOut, 1, PipeTransmissionMode.Byte,
                PipeOptions.Asynchronous | PipeOptions.FirstPipeInstance, 4096, 4096, sec);
        }
        catch (UnauthorizedAccessException e) { throw new SensorPipeException(SensorPipeError.NameInUse, e); }
        catch (IOException e) when ((e.HResult & 0xFFFF) == 231) { throw new SensorPipeException(SensorPipeError.NameInUse, e); } // ERROR_PIPE_BUSY: ayni adli ornek var
        catch (IOException e) { throw new SensorPipeException(SensorPipeError.CreateFailed, e); }
    }

    /// <summary>Canli pipe nesnesinin GERCEK DACL'i (testler ve tanilama icin).</summary>
    public IReadOnlyList<PipeAclEntry> DescribeAcl()
    {
        var s = _stream ?? throw new InvalidOperationException("baslamadi");
        return s.GetAccessControl().GetAccessRules(true, true, typeof(SecurityIdentifier))
            .Cast<PipeAccessRule>()
            .Select(r => new PipeAclEntry((SecurityIdentifier)r.IdentityReference, r.AccessControlType, r.PipeAccessRights))
            .ToList();
    }

    public async Task RunAsync(CancellationToken ct)
    {
        var stream = _stream ?? throw new InvalidOperationException("once Start()");
        while (!ct.IsCancellationRequested)
        {
            try { await stream.WaitForConnectionAsync(ct).ConfigureAwait(false); }
            catch (IOException)
            {
                // Istemci baglanip biz kabul etmeden kapandi (ERROR_NO_DATA, "The pipe is being closed"): bu bir istemci davranisidir, sunucu hatasi DEGIL.
                // Dongu surer, siradaki istemci kabul edilir. (Daha once kontrolsuz cikip yardimci sureci oldurup aralikli test hatasina yol aciyordu.)
                // Bu durumda ornek "kapaniyor" halinde takili kalir ve .NET Disconnect() bunu temizlemez: ornek YENIDEN olusturulur.
                // FirstPipeInstance burada da gecerlidir: bu arada ad baska bir surec tarafindan kapilmissa olusturma NameInUse ile BASARISIZ olur (guvenli taraf).
                try { stream.Dispose(); } catch (Exception) { }
                stream = _stream = CreateStream();
                await Task.Delay(10, ct).ConfigureAwait(false);   // kalici bir hata durumunda cekirdegi mesgul etmesin
                continue;
            }
            try { await ServeAsync(stream, ct).ConfigureAwait(false); }
            catch (SensorProtocolException) { /* bozuk/kesik istek veya istemci kapandi: baglantiyi birak */ }
            catch (IOException) { }
            catch (ObjectDisposedException) { }
            finally
            {
                try { stream.Disconnect(); } catch (InvalidOperationException) { }
            }
        }
    }

    private async Task ServeAsync(NamedPipeServerStream stream, CancellationToken ct)
    {
        if (_expectedClientPid is { } want)
        {
            if (!PipeNative.GetNamedPipeClientProcessId(stream.SafePipeHandle, out var pid) || pid != (uint)want) return; // protokol baslamadan dus
        }
        while (stream.IsConnected && !ct.IsCancellationRequested)
        {
            await SensorProtocol.ReadRequestAsync(stream, ct).ConfigureAwait(false);
            var resp = await BuildResponseAsync(ct).ConfigureAwait(false);
            await stream.WriteAsync(resp, ct).ConfigureAwait(false);
            await stream.FlushAsync(ct).ConfigureAwait(false);
        }
    }

    private static byte[] AllProviderError() => SensorProtocol.EncodeResponse(
        Enum.GetValues<SensorId>().Select(id => new SensorReading(id, SensorStatus.ProviderError, 0.0)).ToList());

    private async Task<byte[]> BuildResponseAsync(CancellationToken ct)
    {
        if (_inflight is { IsCompleted: false }) return AllProviderError(); // takili cagri suruyor: yenisi baslatilmaz (yigilma yok)
        using var tcts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        tcts.CancelAfter(_providerTimeout);
        var task = Task.Run(() => _provider.ReadAllAsync(tcts.Token), CancellationToken.None);
        _inflight = task;
        var done = await Task.WhenAny(task, Task.Delay(_providerTimeout, ct)).ConfigureAwait(false);
        ct.ThrowIfCancellationRequested();
        if (done != task)
        {
            _ = task.ContinueWith(t => _ = t.Exception, TaskContinuationOptions.OnlyOnFaulted);
            return AllProviderError();
        }
        try { return SensorProtocol.EncodeResponse(await task.ConfigureAwait(false)); }
        catch (OperationCanceledException) when (ct.IsCancellationRequested) { throw; }
        catch (Exception) { return AllProviderError(); } // saglayici firlatti / gecersiz veri verdi
    }

    public ValueTask DisposeAsync()
    {
        _stream?.Dispose();
        return ValueTask.CompletedTask;
    }
}

/// <summary>
/// Agent tarafi istemci. Baglanir baglanmaz, tek bayt yazmadan ONCE pipe sunucusunun beklenen yardimci surec oldugunu dogrular
/// (GetNamedPipeServerProcessId == surec handle'indan alinan PID ve surec cikmamis). Tek ucus: es zamanli ikinci okuma Busy.
/// Zaman asimi/protokol hatasi/IO hatasi baglantiyi BOZAR (kapatir): gec gelen yanit sonraki isteginin yanitina karisamaz.
/// </summary>
public sealed class SensorPipeClient : IAsyncDisposable
{
    private readonly NamedPipeClientStream _pipe;
    private readonly SemaphoreSlim _gate = new(1, 1);
    private volatile bool _broken;

    private SensorPipeClient(NamedPipeClientStream pipe) => _pipe = pipe;

    public static async Task<SensorPipeClient> ConnectAsync(string pipeName, IHelperIdentity expected, TimeSpan timeout, CancellationToken ct)
    {
        var pipe = new NamedPipeClientStream(".", pipeName, PipeDirection.InOut, PipeOptions.Asynchronous, TokenImpersonationLevel.Identification);
        try
        {
            try { await pipe.ConnectAsync((int)timeout.TotalMilliseconds, ct).ConfigureAwait(false); }
            catch (UnauthorizedAccessException e) { throw new SensorPipeException(SensorPipeError.ConnectFailed, e); }
            catch (TimeoutException e) { throw new SensorPipeException(SensorPipeError.ConnectFailed, e); }
            catch (IOException e) { throw new SensorPipeException(SensorPipeError.ConnectFailed, e); }

            if (expected.HasExited
                || !PipeNative.GetNamedPipeServerProcessId(pipe.SafePipeHandle, out var serverPid)
                || serverPid != (uint)expected.Pid)
                throw new SensorPipeException(SensorPipeError.ServerIdentityMismatch);

            return new SensorPipeClient(pipe);
        }
        catch
        {
            await pipe.DisposeAsync().ConfigureAwait(false);
            throw;
        }
    }

    public async Task<IReadOnlyList<SensorReading>> ReadAllAsync(TimeSpan timeout, CancellationToken ct)
    {
        if (_broken) throw new SensorPipeException(SensorPipeError.Broken);
        if (!_gate.Wait(0)) throw new SensorPipeException(SensorPipeError.Busy);
        try
        {
            using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
            cts.CancelAfter(timeout);
            try
            {
                await _pipe.WriteAsync(SensorProtocol.EncodeRequest(), cts.Token).ConfigureAwait(false);
                await _pipe.FlushAsync(cts.Token).ConfigureAwait(false);
                return await SensorProtocol.ReadResponseAsync(_pipe, cts.Token).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (!ct.IsCancellationRequested)
            {
                Break();
                throw new SensorPipeException(SensorPipeError.Timeout);
            }
            catch (SensorProtocolException) { Break(); throw; }
            catch (IOException e) { Break(); throw new SensorPipeException(SensorPipeError.Broken, e); }
            catch (ObjectDisposedException e) { Break(); throw new SensorPipeException(SensorPipeError.Broken, e); }
            catch (OperationCanceledException) { Break(); throw; }
        }
        finally { _gate.Release(); }
    }

    private void Break()
    {
        _broken = true;
        try { _pipe.Dispose(); } catch { }
    }

    public ValueTask DisposeAsync()
    {
        _broken = true;
        return _pipe.DisposeAsync();
    }
}
