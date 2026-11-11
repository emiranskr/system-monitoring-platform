using System.Net.NetworkInformation;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;

namespace SysMon.Agent.Collectors;

[SupportedOSPlatform("windows")]
public sealed class WindowsMemoryInfoSource : IMemoryInfoSource
{
    [StructLayout(LayoutKind.Sequential)]
    private struct MemoryStatusEx
    {
        public uint dwLength;
        public uint dwMemoryLoad;
        public ulong ullTotalPhys;
        public ulong ullAvailPhys;
        public ulong ullTotalPageFile;
        public ulong ullAvailPageFile;
        public ulong ullTotalVirtual;
        public ulong ullAvailVirtual;
        public ulong ullAvailExtendedVirtual;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GlobalMemoryStatusEx(ref MemoryStatusEx buffer);

    public MemoryInfo Read()
    {
        var s = new MemoryStatusEx { dwLength = (uint)Marshal.SizeOf<MemoryStatusEx>() };
        if (!GlobalMemoryStatusEx(ref s))
            throw new InvalidOperationException($"GlobalMemoryStatusEx basarisiz: {Marshal.GetLastWin32Error()}");
        return new MemoryInfo(s.ullTotalPhys, s.ullAvailPhys);
    }
}

public sealed class SystemDriveSource : IDriveSource
{
    public IReadOnlyList<DriveSnapshot> Read() =>
        DriveInfo.GetDrives()
            .Where(d => d.DriveType == DriveType.Fixed && d.IsReady)
            .Select(d => new DriveSnapshot(d.Name[..1].ToUpperInvariant(), d.TotalSize, d.AvailableFreeSpace))
            .ToList();
}

public sealed class SystemNetworkSource : INetworkSource
{
    public IReadOnlyList<NicCounters> Read() =>
        NetworkInterface.GetAllNetworkInterfaces()
            .Where(n => n.OperationalStatus == OperationalStatus.Up
                        && n.NetworkInterfaceType is not (NetworkInterfaceType.Loopback or NetworkInterfaceType.Tunnel))
            .Select(n =>
            {
                var s = n.GetIPStatistics();
                return new NicCounters(n.Name, (ulong)s.BytesReceived, (ulong)s.BytesSent);
            })
            .ToList();
}

/// <summary>
/// PDH ile CPU kullanimi. PdhAddEnglishCounter kullanilir: yerellestirilmis Windows'ta
/// (ornegin Turkce) sayac adlari farkli oldugundan PerformanceCounter sinifi guvenilmezdir.
/// Baslatma hatasi (ornegin dusuk yetkili hesapta sayac erisimi yok) istisna FIRLATMAZ: Error doner,
/// okuma null verir ve baslatma 60 sn'de bir yeniden denenir. Boylece bir collector tum servisi dusurmez.
/// </summary>
[SupportedOSPlatform("windows")]
public sealed class PdhCpuSource : ICpuSource, IDisposable
{
    private const uint PdhFmtDouble = 0x00000200;
    private const long RetryMs = 60_000;

    private static readonly string[] DefaultPaths =
    [
        @"\Processor Information(_Total)\% Processor Utility", // Win10+: Gorev Yoneticisi ile ayni olcu
        @"\Processor(_Total)\% Processor Time",                // klasik yedek
    ];

    [StructLayout(LayoutKind.Explicit)]
    private struct FmtCounterValue
    {
        [FieldOffset(0)] public uint CStatus;
        [FieldOffset(8)] public double DoubleValue;
    }

    [DllImport("pdh.dll", CharSet = CharSet.Unicode)]
    private static extern uint PdhOpenQueryW(string? dataSource, IntPtr userData, out IntPtr query);
    [DllImport("pdh.dll", CharSet = CharSet.Unicode)]
    private static extern uint PdhAddEnglishCounterW(IntPtr query, string path, IntPtr userData, out IntPtr counter);
    [DllImport("pdh.dll")]
    private static extern uint PdhCollectQueryData(IntPtr query);
    [DllImport("pdh.dll")]
    private static extern uint PdhGetFormattedCounterValue(IntPtr counter, uint format, out uint type, out FmtCounterValue value);
    [DllImport("pdh.dll")]
    private static extern uint PdhCloseQuery(IntPtr query);

    private readonly IReadOnlyList<string> _paths;
    private IntPtr _query;
    private IntPtr _counter;
    private bool _primed;
    private long _lastInitMs = long.MinValue;

    public string? Error { get; private set; }

    public PdhCpuSource(IReadOnlyList<string>? counterPaths = null)
    {
        _paths = counterPaths ?? DefaultPaths;
        TryInit();
    }

    public double? ReadUtilizationPercent()
    {
        if (_query == IntPtr.Zero)
        {
            if (Environment.TickCount64 - _lastInitMs < RetryMs) return null;
            TryInit();
            if (_query == IntPtr.Zero) return null;
        }
        if (PdhCollectQueryData(_query) != 0) return null;
        if (!_primed)
        {
            _primed = true; // hiz sayaci icin ilk ornek yalnizca baseline
            return null;
        }
        if (PdhGetFormattedCounterValue(_counter, PdhFmtDouble, out _, out var v) != 0 || v.CStatus != 0) return null;
        return v.DoubleValue;
    }

    private void TryInit()
    {
        _lastInitMs = Environment.TickCount64;
        Close();
        var open = PdhOpenQueryW(null, IntPtr.Zero, out var q);
        if (open != 0)
        {
            Error = $"PdhOpenQuery basarisiz: 0x{open:X8}";
            return;
        }

        var errors = new List<string>();
        foreach (var path in _paths)
        {
            var st = PdhAddEnglishCounterW(q, path, IntPtr.Zero, out var c);
            if (st == 0)
            {
                _query = q;
                _counter = c;
                _primed = false;
                Error = null;
                return;
            }
            errors.Add($"{path} -> 0x{st:X8}");
        }
        PdhCloseQuery(q);
        Error = "PdhAddEnglishCounter basarisiz: " + string.Join("; ", errors);
    }

    private void Close()
    {
        if (_query != IntPtr.Zero) PdhCloseQuery(_query);
        _query = IntPtr.Zero;
        _counter = IntPtr.Zero;
    }

    public void Dispose() => Close();
}
