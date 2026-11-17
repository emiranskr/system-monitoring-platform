using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text.RegularExpressions;
using Microsoft.Win32.SafeHandles;

namespace SysMon.Agent.Sensors;

/// <summary>Yardimci exe'nin KATI komut satiri: --pipe, --parent-pid, --allow-sid (her biri tam bir kez; baska hicbir sey kabul edilmez).</summary>
public sealed partial record HelperArgs(string PipeName, int ParentPid, SecurityIdentifier AllowedSid)
{
    [GeneratedRegex(@"^sysmon-sensors-[0-9a-f]{32}$")]
    private static partial Regex PipeRe();

    public static bool TryParse(string[] args, out HelperArgs? parsed)
    {
        parsed = null;
        if (args.Length != 6) return false;
        string? pipe = null, pid = null, sid = null;
        for (var i = 0; i < args.Length; i += 2)
        {
            var key = args[i];
            var val = args[i + 1];
            switch (key)
            {
                case "--pipe" when pipe is null: pipe = val; break;
                case "--parent-pid" when pid is null: pid = val; break;
                case "--allow-sid" when sid is null: sid = val; break;
                default: return false; // bilinmeyen, tekrarlanan veya pozisyonel
            }
        }
        if (pipe is null || pid is null || sid is null) return false;
        if (!PipeRe().IsMatch(pipe)) return false;
        if (!int.TryParse(pid, NumberStyles.None, CultureInfo.InvariantCulture, out var ppid) || ppid <= 0) return false;
        if (!sid.StartsWith("S-1-", StringComparison.Ordinal)) return false;
        SecurityIdentifier parsedSid;
        try { parsedSid = new SecurityIdentifier(sid); } catch (ArgumentException) { return false; }
        parsed = new HelperArgs(pipe, ppid, parsedSid);
        return true;
    }
}

public enum HelperExeError { NotAbsolute, NotFound, NotExe, ReparsePoint, UntrustedPermissions }

public sealed class HelperExeException(HelperExeError error, string detail) : Exception($"yardimci exe reddedildi ({error}): {detail}")
{
    public HelperExeError Error { get; } = error;
}

/// <summary>
/// Yardimci exe'yi baslatmadan once denetler: mutlak yol (PATH/calisma dizini aramasi yok), var, .exe, yeniden yonlendirme noktasi
/// (symlink/junction) degil. Uretimde ayrica dosya ve klasorun sahibi ile yazma izinleri YALNIZ SYSTEM/Administrators/TrustedInstaller
/// olmali (standart kullanici exe'yi degistirip agent hesabiyla kod calistiramaz). Kurulum yeri Program Files olmalidir.
/// Sinir: denetim ile baslatma arasinda TOCTOU penceresi vardir; koruma, dizinin yonetici yazimli olmasina dayanir.
/// </summary>
public static class HelperExeValidator
{
    private static readonly HashSet<SecurityIdentifier> Trusted =
    [
        new(WellKnownSidType.LocalSystemSid, null),
        new(WellKnownSidType.BuiltinAdministratorsSid, null),
        new("S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464"), // NT SERVICE\TrustedInstaller
    ];

    private const FileSystemRights WriteMask =
        FileSystemRights.WriteData | FileSystemRights.AppendData | FileSystemRights.WriteExtendedAttributes | FileSystemRights.WriteAttributes |
        FileSystemRights.Delete | FileSystemRights.DeleteSubdirectoriesAndFiles | FileSystemRights.ChangePermissions | FileSystemRights.TakeOwnership;

    public static void Validate(string path, bool requireSecurePermissions)
    {
        if (!Path.IsPathFullyQualified(path) || path != Path.GetFullPath(path))
            throw new HelperExeException(HelperExeError.NotAbsolute, path);
        var file = new FileInfo(path);
        if (!file.Exists) throw new HelperExeException(HelperExeError.NotFound, path);
        if (!string.Equals(file.Extension, ".exe", StringComparison.OrdinalIgnoreCase)) throw new HelperExeException(HelperExeError.NotExe, path);
        if (file.Attributes.HasFlag(FileAttributes.ReparsePoint) || file.Directory!.Attributes.HasFlag(FileAttributes.ReparsePoint))
            throw new HelperExeException(HelperExeError.ReparsePoint, path);
        if (!requireSecurePermissions) return;

        ValidateSecurity(file.GetAccessControl(), path);
        ValidateSecurity(file.Directory.GetAccessControl(), file.Directory.FullName);
    }

    /// <summary>Sahip ve izin denetimi (dosya ve klasor icin ayni kural). Test icin acik.</summary>
    public static void ValidateSecurity(FileSystemSecurity sec, string what)
    {
        if (sec.GetOwner(typeof(SecurityIdentifier)) is not SecurityIdentifier owner || !Trusted.Contains(owner))
            throw new HelperExeException(HelperExeError.UntrustedPermissions, $"sahip guvenilir degil: {what}");
        foreach (FileSystemAccessRule r in sec.GetAccessRules(true, true, typeof(SecurityIdentifier)))
        {
            if (r.AccessControlType != AccessControlType.Allow || (r.FileSystemRights & WriteMask) == 0) continue;
            if (!Trusted.Contains((SecurityIdentifier)r.IdentityReference))
                throw new HelperExeException(HelperExeError.UntrustedPermissions, $"{r.IdentityReference.Value} yazabiliyor: {what}");
        }
    }
}

/// <summary>
/// Windows Job Object: KILL_ON_JOB_CLOSE (agent oluyorsa/handle kapanirsa yardimci da olur) ve ACTIVE_PROCESS=1
/// (yardimci cocuk surec OLUSTURAMAZ). Atama, surec baslatildiktan hemen sonra yapilir (kisa bir pencere vardir; yardimci
/// bizim kodumuzdur ve baslangicta cocuk surec baslatmaz).
/// </summary>
internal sealed class HelperJob : IDisposable
{
    private readonly SafeJobHandle _job;

    private sealed class SafeJobHandle() : SafeHandleZeroOrMinusOneIsInvalid(true)
    {
        protected override bool ReleaseHandle() => CloseHandle(handle);
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct BasicLimit
    {
        public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
        public uint LimitFlags;
        public nuint MinimumWorkingSetSize, MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public nuint Affinity;
        public uint PriorityClass, SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IoCounters { public ulong A, B, C, D, E, F; }

    [StructLayout(LayoutKind.Sequential)]
    private struct ExtendedLimit
    {
        public BasicLimit Basic;
        public IoCounters Io;
        public nuint ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
    }

    private const uint KillOnJobClose = 0x2000, ActiveProcess = 0x8;
    private const int ExtendedLimitInformation = 9;

    [DllImport("kernel32.dll", SetLastError = true)] private static extern SafeJobHandle CreateJobObjectW(nint attrs, string? name);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool SetInformationJobObject(SafeJobHandle job, int cls, ref ExtendedLimit info, int size);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool AssignProcessToJobObject(SafeJobHandle job, nint process);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool TerminateJobObject(SafeJobHandle job, uint exitCode);
    [DllImport("kernel32.dll")] private static extern bool CloseHandle(nint h);

    public HelperJob()
    {
        _job = CreateJobObjectW(0, null);
        if (_job.IsInvalid) throw new InvalidOperationException("job olusturulamadi: " + Marshal.GetLastWin32Error());
        var info = new ExtendedLimit { Basic = { LimitFlags = KillOnJobClose | ActiveProcess, ActiveProcessLimit = 1 } };
        if (!SetInformationJobObject(_job, ExtendedLimitInformation, ref info, Marshal.SizeOf<ExtendedLimit>()))
            throw new InvalidOperationException("job sinirlari ayarlanamadi: " + Marshal.GetLastWin32Error());
    }

    public void Assign(Process p)
    {
        if (!AssignProcessToJobObject(_job, p.Handle))
            throw new InvalidOperationException("surec job'a atanamadi: " + Marshal.GetLastWin32Error());
    }

    public void Terminate() => TerminateJobObject(_job, 1);

    public void Dispose() => _job.Dispose();
}

/// <summary>Gercek yardimci surec: Process handle'i + Job Object yasam dongusu boyunca tutulur (PID yeniden kullanimi olamaz).</summary>
public sealed class ProcessHelper : IHelperProcess
{
    private readonly Process _process;
    private readonly HelperJob _job;
    private volatile bool _disposed;

    internal ProcessHelper(Process process, HelperJob job) { _process = process; _job = job; }

    public int Pid => _process.Id;
    // Dispose sonrasi Job kapandigi icin surec olu sayilir (Process nesnesi artik sorgulanamaz)
    public bool HasExited => _disposed || _process.HasExited;
    public int? ExitCode => !_disposed && _process.HasExited ? _process.ExitCode : null;

    public void Kill() => _job.Terminate();

    public async Task<bool> WaitForExitAsync(TimeSpan timeout)
    {
        if (_disposed) return true; // Job kapandi: surec olu
        using var cts = new CancellationTokenSource(timeout);
        try { await _process.WaitForExitAsync(cts.Token).ConfigureAwait(false); return true; }
        catch (OperationCanceledException) { return _process.HasExited; }
    }

    public ValueTask DisposeAsync()
    {
        _disposed = true;
        _job.Dispose();      // KILL_ON_JOB_CLOSE: hala yasiyorsa oldurur
        _process.Dispose();
        return ValueTask.CompletedTask;
    }
}

/// <summary>
/// Yardimciyi guvenli baslatir: yol dogrulanir (<see cref="HelperExeValidator"/>), shell YOK (UseShellExecute=false), PATH aramasi YOK,
/// komut satirina yalniz katı argumanlar verilir, surec Job Object'e alinir (cocuk surec yok, agent olurse yardimci da olur).
/// </summary>
public sealed class ProcessHelperLauncher(string exePath, SecurityIdentifier allowedClient, int parentPid, bool requireSecurePermissions) : IHelperLauncher
{
    public IHelperProcess Start(string pipeName)
    {
        HelperExeValidator.Validate(exePath, requireSecurePermissions);
        var psi = new ProcessStartInfo(exePath)
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            WorkingDirectory = Path.GetDirectoryName(exePath)!,
        };
        psi.ArgumentList.Add("--pipe"); psi.ArgumentList.Add(pipeName);
        psi.ArgumentList.Add("--parent-pid"); psi.ArgumentList.Add(parentPid.ToString(CultureInfo.InvariantCulture));
        psi.ArgumentList.Add("--allow-sid"); psi.ArgumentList.Add(allowedClient.Value);

        var job = new HelperJob();
        Process? p = null;
        try
        {
            p = Process.Start(psi) ?? throw new InvalidOperationException("surec baslatilamadi");
            job.Assign(p);
            return new ProcessHelper(p, job);
        }
        catch
        {
            try { p?.Kill(true); } catch { }
            p?.Dispose();
            job.Dispose();
            throw;
        }
    }
}
