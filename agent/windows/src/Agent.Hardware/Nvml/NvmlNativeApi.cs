using System.Runtime.InteropServices;
using System.Text;

namespace SysMon.Agent.Hardware.Nvml;

/// <summary>
/// Gercek nvml.dll baglayicisi (kendi minimal P/Invoke tanimlarimiz; nvml.h kopyalanmaz, DLL yeniden dagitilmaz).
/// DLL yalnizca SABIT MUTLAK yollardan yuklenir (System32, NVSMI): arama yolu ele gecirmesine (DLL planting) acik degildir.
/// DLL/export yoksa firlatmaz: <see cref="NvmlStatus.LibraryNotFound"/> / <see cref="NvmlStatus.FunctionNotFound"/> doner.
/// Native cagrilar bloklanabilir ve fiziksel olarak sonlandirilamaz; sorumlu <see cref="NvmlGpuProvider"/> (Busy korumasi).
/// </summary>
public sealed unsafe class NvmlNativeApi : INvmlApi, IDisposable
{
    private readonly string[] _candidates;
    private nint _lib;
    private bool _inited;
    private bool _disposed;

    private delegate* unmanaged[Cdecl]<int> _init, _shutdown;
    private delegate* unmanaged[Cdecl]<uint*, int> _count;
    private delegate* unmanaged[Cdecl]<uint, nint*, int> _byIndex;
    private delegate* unmanaged[Cdecl]<nint, byte*, uint, int> _uuid, _name;
    private delegate* unmanaged[Cdecl]<nint, uint*, int> _util, _power, _fan;
    private delegate* unmanaged[Cdecl]<nint, ulong*, int> _mem;
    private delegate* unmanaged[Cdecl]<nint, ulong*, int> _mem2; // opsiyonel: nvmlDeviceGetMemoryInfo_v2 (ayrilmis bellegi ayirir; nvidia-smi ile ayni "used")
    private delegate* unmanaged[Cdecl]<nint, int, uint*, int> _temp, _clock;

    public NvmlNativeApi(string? libraryPath = null)
    {
        _candidates = libraryPath is null ? DefaultLibraryCandidates() : [libraryPath];
    }

    /// <summary>Surucunun dagittigi yerler (mutlak yol): System32 ve NVSMI.</summary>
    public static string[] DefaultLibraryCandidates() =>
    [
        Path.Combine(Environment.SystemDirectory, "nvml.dll"),
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "NVIDIA Corporation", "NVSMI", "nvml.dll"),
    ];

    private static NvmlStatus Map(int rc) => Enum.IsDefined(typeof(NvmlStatus), rc) ? (NvmlStatus)rc : NvmlStatus.Unknown;

    private NvmlStatus Load()
    {
        if (_lib != 0) return NvmlStatus.Success;
        foreach (var path in _candidates)
        {
            if (!File.Exists(path)) continue;
            if (!NativeLibrary.TryLoad(path, out var h)) continue;
            if (Resolve(h)) { _lib = h; return NvmlStatus.Success; }
            NativeLibrary.Free(h);
            return NvmlStatus.FunctionNotFound;
        }
        return NvmlStatus.LibraryNotFound;
    }

    private bool Resolve(nint h)
    {
        bool Get(string name, out nint p) => NativeLibrary.TryGetExport(h, name, out p);
        if (!(Get("nvmlInit_v2", out var init) && Get("nvmlShutdown", out var shut) && Get("nvmlDeviceGetCount_v2", out var cnt)
            && Get("nvmlDeviceGetHandleByIndex_v2", out var idx) && Get("nvmlDeviceGetUUID", out var uuid) && Get("nvmlDeviceGetName", out var name)
            && Get("nvmlDeviceGetUtilizationRates", out var util) && Get("nvmlDeviceGetMemoryInfo", out var mem)
            && Get("nvmlDeviceGetTemperature", out var temp) && Get("nvmlDeviceGetPowerUsage", out var pow)
            && Get("nvmlDeviceGetFanSpeed", out var fan) && Get("nvmlDeviceGetClockInfo", out var clk)))
            return false;
        _init = (delegate* unmanaged[Cdecl]<int>)init;
        _shutdown = (delegate* unmanaged[Cdecl]<int>)shut;
        _count = (delegate* unmanaged[Cdecl]<uint*, int>)cnt;
        _byIndex = (delegate* unmanaged[Cdecl]<uint, nint*, int>)idx;
        _uuid = (delegate* unmanaged[Cdecl]<nint, byte*, uint, int>)uuid;
        _name = (delegate* unmanaged[Cdecl]<nint, byte*, uint, int>)name;
        _util = (delegate* unmanaged[Cdecl]<nint, uint*, int>)util;
        _mem = (delegate* unmanaged[Cdecl]<nint, ulong*, int>)mem;
        _temp = (delegate* unmanaged[Cdecl]<nint, int, uint*, int>)temp;
        _power = (delegate* unmanaged[Cdecl]<nint, uint*, int>)pow;
        _fan = (delegate* unmanaged[Cdecl]<nint, uint*, int>)fan;
        _clock = (delegate* unmanaged[Cdecl]<nint, int, uint*, int>)clk;
        _mem2 = Get("nvmlDeviceGetMemoryInfo_v2", out var m2) ? (delegate* unmanaged[Cdecl]<nint, ulong*, int>)m2 : null;
        return true;
    }

    public NvmlStatus Init()
    {
        if (_disposed) return NvmlStatus.Uninitialized;
        var l = Load();
        if (l != NvmlStatus.Success) return l;
        var rc = Map(_init());
        if (rc == NvmlStatus.Success) _inited = true;
        return rc;
    }

    public NvmlStatus Shutdown()
    {
        if (_lib == 0 || !_inited) return NvmlStatus.Uninitialized;
        _inited = false;
        return Map(_shutdown());
    }

    public NvmlStatus GetDeviceCount(out uint count)
    {
        uint c = 0;
        var rc = Map(_count(&c));
        count = c;
        return rc;
    }

    public NvmlStatus GetHandleByIndex(uint index, out nint handle)
    {
        nint h = 0;
        var rc = Map(_byIndex(index, &h));
        handle = h;
        return rc;
    }

    private static string Ascii(byte* buf, int cap)
    {
        var n = 0;
        while (n < cap && buf[n] != 0) n++;
        return Encoding.ASCII.GetString(buf, n);
    }

    public NvmlStatus GetUuid(nint handle, out string uuid)
    {
        byte* buf = stackalloc byte[96];
        var rc = Map(_uuid(handle, buf, 96));
        uuid = rc == NvmlStatus.Success ? Ascii(buf, 96) : "";
        return rc;
    }

    public NvmlStatus GetName(nint handle, out string name)
    {
        byte* buf = stackalloc byte[96];
        var rc = Map(_name(handle, buf, 96));
        name = rc == NvmlStatus.Success ? Ascii(buf, 96) : "";
        return rc;
    }

    public NvmlStatus GetUtilization(nint handle, out uint gpuPct)
    {
        uint* r = stackalloc uint[2]; // nvmlUtilization_t { gpu, memory }
        r[0] = 0; r[1] = 0;
        var rc = Map(_util(handle, r));
        gpuPct = r[0];
        return rc;
    }

    public NvmlStatus GetMemory(nint handle, out ulong totalBytes, out ulong usedBytes)
    {
        if (_mem2 != null)
        {
            // nvmlMemory_v2_t { uint version; (4 bayt dolgu) ulong total, reserved, free, used }; version = boyut(40) | (2 << 24)
            ulong* m2 = stackalloc ulong[5];
            for (var i = 0; i < 5; i++) m2[i] = 0;
            m2[0] = 40UL | (2UL << 24);
            var rc2 = Map(_mem2(handle, m2));
            if (rc2 == NvmlStatus.Success) { totalBytes = m2[1]; usedBytes = m2[4]; return rc2; }
            if (rc2 is NvmlStatus.GpuIsLost or NvmlStatus.Uninitialized) { totalBytes = 0; usedBytes = 0; return rc2; }
            // eski surucu / surum uyusmazligi: v1'e dus (used ayrilmis bellegi de icerir)
        }
        ulong* m = stackalloc ulong[3]; // nvmlMemory_t { total, free, used }
        m[0] = 0; m[1] = 0; m[2] = 0;
        var rc = Map(_mem(handle, m));
        totalBytes = m[0];
        usedBytes = m[2];
        return rc;
    }

    public NvmlStatus GetTemperatureC(nint handle, out uint celsius)
    {
        uint v = 0;
        var rc = Map(_temp(handle, 0 /* GPU sensoru */, &v));
        celsius = v;
        return rc;
    }

    public NvmlStatus GetPowerMilliwatts(nint handle, out uint milliwatts)
    {
        uint v = 0;
        var rc = Map(_power(handle, &v));
        milliwatts = v;
        return rc;
    }

    public NvmlStatus GetFanPercent(nint handle, out uint pct)
    {
        uint v = 0;
        var rc = Map(_fan(handle, &v));
        pct = v;
        return rc;
    }

    public NvmlStatus GetCoreClockMHz(nint handle, out uint mhz)
    {
        uint v = 0;
        var rc = Map(_clock(handle, 0 /* graphics */, &v));
        mhz = v;
        return rc;
    }

    public NvmlStatus GetMemClockMHz(nint handle, out uint mhz)
    {
        uint v = 0;
        var rc = Map(_clock(handle, 2 /* bellek */, &v));
        mhz = v;
        return rc;
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        if (_lib == 0) return;
        if (_inited) { _inited = false; _shutdown(); }
        NativeLibrary.Free(_lib);
        _lib = 0;
    }
}
