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
/// </summary>
[SupportedOSPlatform("windows")]
public sealed class PdhCpuSource : ICpuSource, IDisposable
{
    private const uint PdhFmtDouble = 0x00000200;

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

    private readonly IntPtr _query;
    private readonly IntPtr _counter;
    private bool _primed;

    public PdhCpuSource()
    {
        Check(PdhOpenQueryW(null, IntPtr.Zero, out _query), "PdhOpenQuery");
        // Win10+: Gorev Yoneticisi ile ayni olcu. Yoksa klasik sayaca dus.
        if (PdhAddEnglishCounterW(_query, @"\Processor Information(_Total)\% Processor Utility", IntPtr.Zero, out _counter) != 0)
            Check(PdhAddEnglishCounterW(_query, @"\Processor(_Total)\% Processor Time", IntPtr.Zero, out _counter), "PdhAddEnglishCounter");
    }

    public double? ReadUtilizationPercent()
    {
        if (PdhCollectQueryData(_query) != 0) return null;
        if (!_primed)
        {
            _primed = true; // hiz sayaci icin ilk ornek yalnizca baseline
            return null;
        }
        if (PdhGetFormattedCounterValue(_counter, PdhFmtDouble, out _, out var v) != 0 || v.CStatus != 0) return null;
        return v.DoubleValue;
    }

    private static void Check(uint status, string op)
    {
        if (status != 0) throw new InvalidOperationException($"{op} basarisiz: 0x{status:X8}");
    }

    public void Dispose() => PdhCloseQuery(_query);
}
