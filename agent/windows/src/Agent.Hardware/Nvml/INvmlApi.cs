namespace SysMon.Agent.Hardware.Nvml;

/// <summary>
/// NVML'e ince sinir. Saglayici yalnizca bu arayuzu bilir: testler sahte NVML ile (DLL/surucu olmadan) yazilir.
/// Hicbir metot firlatmaz; hatalar <see cref="NvmlStatus"/> olarak doner. Tutamaclar opak degerlerdir.
/// </summary>
public interface INvmlApi
{
    NvmlStatus Init();
    NvmlStatus Shutdown();
    NvmlStatus GetDeviceCount(out uint count);
    NvmlStatus GetHandleByIndex(uint index, out nint handle);
    NvmlStatus GetUuid(nint handle, out string uuid);
    NvmlStatus GetName(nint handle, out string name);
    NvmlStatus GetUtilization(nint handle, out uint gpuPct);
    NvmlStatus GetMemory(nint handle, out ulong totalBytes, out ulong usedBytes);
    NvmlStatus GetTemperatureC(nint handle, out uint celsius);
    NvmlStatus GetPowerMilliwatts(nint handle, out uint milliwatts);
    NvmlStatus GetFanPercent(nint handle, out uint pct);
    NvmlStatus GetCoreClockMHz(nint handle, out uint mhz);
    NvmlStatus GetMemClockMHz(nint handle, out uint mhz);
}
