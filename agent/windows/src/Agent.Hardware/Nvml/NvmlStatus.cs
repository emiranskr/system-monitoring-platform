namespace SysMon.Agent.Hardware.Nvml;

/// <summary>NVML donus kodlari (kendi tanimimiz; yalnizca kullandigimiz degerler). Bilinmeyen kodlar <see cref="Unknown"/> olur.</summary>
public enum NvmlStatus
{
    Success = 0,
    Uninitialized = 1,
    InvalidArgument = 2,
    NotSupported = 3,
    NoPermission = 4,
    AlreadyInitialized = 5,
    NotFound = 6,
    InsufficientSize = 7,
    DriverNotLoaded = 9,
    Timeout = 10,
    LibraryNotFound = 12,
    FunctionNotFound = 13,
    GpuIsLost = 15,
    ResetRequired = 16,
    Unknown = 999,
}
