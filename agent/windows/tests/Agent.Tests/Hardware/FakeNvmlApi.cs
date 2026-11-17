using SysMon.Agent.Hardware.Nvml;

namespace Agent.Tests.Hardware;

public sealed class FakeNvmlGpu
{
    public string Uuid { get; set; } = "GPU-46139694-b075-6c98-9b95-3b6f3a465823";
    public string Name { get; set; } = "Fake GPU";
    public uint Util { get; set; } = 40;
    public NvmlStatus UtilStatus { get; set; } = NvmlStatus.Success;
    public ulong Total { get; set; } = 8UL << 30;
    public ulong Used { get; set; } = 1UL << 30;
    public NvmlStatus MemStatus { get; set; } = NvmlStatus.Success;
    public uint TempC { get; set; } = 55;
    public NvmlStatus TempStatus { get; set; } = NvmlStatus.Success;
    public uint PowerMw { get; set; } = 90_000;
    public NvmlStatus PowerStatus { get; set; } = NvmlStatus.Success;
    public uint FanPct { get; set; } = 30;
    public NvmlStatus FanStatus { get; set; } = NvmlStatus.Success;
    public uint CoreMHz { get; set; } = 1800;
    public NvmlStatus CoreStatus { get; set; } = NvmlStatus.Success;
    public uint MemMHz { get; set; } = 9000;
    public NvmlStatus MemClockStatus { get; set; } = NvmlStatus.Success;
}

/// <summary>NVML'siz test: kaynak dengesi (Init/Shutdown, acik cagri) ve hata durumlarini betikler.</summary>
public sealed class FakeNvmlApi : INvmlApi
{
    public NvmlStatus InitStatus { get; set; } = NvmlStatus.Success;
    public List<FakeNvmlGpu> Gpus { get; } = [];
    /// <summary>true iken tum cihaz sorgulari GPU_IS_LOST doner (surucu reseti / GPU dustu).</summary>
    public bool Lost { get; set; }
    /// <summary>Kullanim sorgusunda cagrilir (bloklayan native cagriyi taklit etmek icin).</summary>
    public Action? BeforeUtilization { get; set; }

    private int _init, _shutdown, _live;
    public int InitCalls => _init;
    public int ShutdownCalls => _shutdown;
    /// <summary>Basarili Init - Shutdown (0 olmali: sizinti yok).</summary>
    public int LiveInits => _live;

    public NvmlStatus Init()
    {
        Interlocked.Increment(ref _init);
        if (InitStatus != NvmlStatus.Success) return InitStatus;
        Interlocked.Increment(ref _live);
        return NvmlStatus.Success;
    }

    public NvmlStatus Shutdown()
    {
        Interlocked.Increment(ref _shutdown);
        Interlocked.Decrement(ref _live);
        return NvmlStatus.Success;
    }

    public NvmlStatus GetDeviceCount(out uint count) { count = (uint)Gpus.Count; return Lost ? NvmlStatus.GpuIsLost : NvmlStatus.Success; }

    public NvmlStatus GetHandleByIndex(uint index, out nint handle)
    {
        handle = (nint)(index + 1);
        return index < Gpus.Count ? NvmlStatus.Success : NvmlStatus.InvalidArgument;
    }

    private FakeNvmlGpu G(nint h) => Gpus[(int)h - 1];
    private NvmlStatus Q(NvmlStatus own) => Lost ? NvmlStatus.GpuIsLost : own;

    public NvmlStatus GetUuid(nint h, out string uuid) { uuid = G(h).Uuid; return Q(NvmlStatus.Success); }
    public NvmlStatus GetName(nint h, out string name) { name = G(h).Name; return Q(NvmlStatus.Success); }
    public NvmlStatus GetUtilization(nint h, out uint pct) { BeforeUtilization?.Invoke(); pct = G(h).Util; return Q(G(h).UtilStatus); }
    public NvmlStatus GetMemory(nint h, out ulong total, out ulong used) { total = G(h).Total; used = G(h).Used; return Q(G(h).MemStatus); }
    public NvmlStatus GetTemperatureC(nint h, out uint c) { c = G(h).TempC; return Q(G(h).TempStatus); }
    public NvmlStatus GetPowerMilliwatts(nint h, out uint mw) { mw = G(h).PowerMw; return Q(G(h).PowerStatus); }
    public NvmlStatus GetFanPercent(nint h, out uint pct) { pct = G(h).FanPct; return Q(G(h).FanStatus); }
    public NvmlStatus GetCoreClockMHz(nint h, out uint mhz) { mhz = G(h).CoreMHz; return Q(G(h).CoreStatus); }
    public NvmlStatus GetMemClockMHz(nint h, out uint mhz) { mhz = G(h).MemMHz; return Q(G(h).MemClockStatus); }
}
