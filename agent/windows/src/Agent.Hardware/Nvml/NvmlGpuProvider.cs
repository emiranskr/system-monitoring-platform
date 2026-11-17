using System.Collections.Concurrent;

namespace SysMon.Agent.Hardware.Nvml;

public sealed record NvmlOptions(int MaxInitFailures = 3, TimeSpan? Cooldown = null)
{
    public TimeSpan CooldownOrDefault => Cooldown ?? TimeSpan.FromMinutes(5);
}

/// <summary>
/// NVML tabanli GPU saglayicisi. Kurallar:
/// - null anlami: NOT_SUPPORTED -> alan null; GPU_IS_LOST/gecersiz tutamak -> <see cref="GpuLostException"/> (kismi/eskimis veri YOK);
///   Init/DLL hatasi -> saglayici kullanilamaz (IsAvailable=false). Gercek sifir null ile karismaz.
/// - Birim donusumu burada tek yerde: mW->W, bayt; aralik disi/negatif/tasan degerler sessizce duzeltilmez, alan null olur.
/// - Devre kesici: ardisik Init hatasi veya GPU kaybi MaxInitFailures'a ulasinca Cooldown boyunca yeni Init denenmez;
///   sonra TEK deneme (yari acik). Basarili tam okuma sayaci sifirlar. Sonsuz yeniden deneme yok.
/// - Native cagrilar tek kapi (_gate) altinda seri; bloklu cagri kapiyi tutarsa yeni okumalar <see cref="GpuProviderBusyException"/>
///   ile hizla reddedilir (yigilmaz), IsAvailable/Capabilities bloklanmaz. NOT: zaman asimi native cagriyi SONLANDIRMAZ
///   (GpuReader yalniz bekleyeni birakir); bloklu cagri arka planda surer.
/// - Shutdown yalnizca bu saglayicinin basarili Init'i icin ve bir kez cagrilir.
/// </summary>
public sealed class NvmlGpuProvider : IGpuProvider, IDisposable
{
    private readonly INvmlApi _api;
    private readonly Func<DateTimeOffset> _clock;
    private readonly NvmlOptions _opt;
    private readonly object _gate = new();
    private readonly Dictionary<string, nint> _handles = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, GpuCapabilities> _caps = new(StringComparer.Ordinal);

    private volatile bool _initialized;
    private volatile bool _disposed;
    private int _failures;
    private DateTimeOffset _openUntil = DateTimeOffset.MinValue;

    public NvmlGpuProvider(INvmlApi api, Func<DateTimeOffset>? clock = null, NvmlOptions? options = null)
    {
        _api = api;
        _clock = clock ?? (() => DateTimeOffset.UtcNow);
        _opt = options ?? new NvmlOptions();
    }

    public string Id => "nvml";
    public int Priority => 100;

    public bool IsAvailable()
    {
        if (!Monitor.TryEnter(_gate)) return _initialized && !_disposed; // kapi mesgul (bloklu cagri): bloklanma, bilinen durumu don
        try { return EnsureInitializedLocked(); }
        finally { Monitor.Exit(_gate); }
    }

    public GpuCapabilities Capabilities(GpuDevice device) =>
        _caps.TryGetValue(device.CanonicalId, out var c) ? c : GpuCapabilities.None;

    public Task<IReadOnlyList<GpuDevice>> DiscoverAsync(CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        if (!Monitor.TryEnter(_gate)) throw new GpuProviderBusyException();
        try
        {
            if (!EnsureInitializedLocked()) return Task.FromResult<IReadOnlyList<GpuDevice>>([]);
            return Task.FromResult(DiscoverLocked());
        }
        catch (GpuLostException)
        {
            return Task.FromResult<IReadOnlyList<GpuDevice>>([]); // kayip: durum sifirlandi, devre kesici sayiyor
        }
        finally { Monitor.Exit(_gate); }
    }

    public Task<GpuSample> ReadAsync(GpuDevice device, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        if (!Monitor.TryEnter(_gate)) throw new GpuProviderBusyException();
        try
        {
            if (!_initialized || !_handles.TryGetValue(device.CanonicalId, out var h))
                throw new GpuLostException("NVML tutamagi yok: yeniden kesif gerekli");
            return Task.FromResult(ReadLocked(h, _caps.GetValueOrDefault(device.CanonicalId)));
        }
        finally { Monitor.Exit(_gate); }
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        // Bloklu native cagri kapiyi tutuyorsa sonsuza dek beklemeyiz; surec kapanirken surucu kaynagi zaten birakilir.
        if (!Monitor.TryEnter(_gate, TimeSpan.FromSeconds(2))) return;
        try
        {
            if (_initialized) { _initialized = false; _api.Shutdown(); }
            _handles.Clear();
        }
        finally { Monitor.Exit(_gate); }
    }

    // ---------- kapi altinda ----------

    private bool EnsureInitializedLocked()
    {
        if (_disposed) return false;
        if (_initialized) return true;
        var now = _clock();
        if (now < _openUntil) return false; // devre kesici acik
        var st = _api.Init();
        if (st is NvmlStatus.Success or NvmlStatus.AlreadyInitialized) { _initialized = true; return true; }
        RecordFailureLocked(now);
        return false;
    }

    private void RecordFailureLocked(DateTimeOffset now)
    {
        _failures++;
        if (_failures >= _opt.MaxInitFailures) _openUntil = now + _opt.CooldownOrDefault;
    }

    /// <summary>GPU kaybi: native durumu birak, tutamaclari at, kesiciye say. Her zaman GpuLostException firlatir.</summary>
    private GpuLostException LoseLocked(NvmlStatus st)
    {
        if (_initialized) { _initialized = false; _api.Shutdown(); }
        _handles.Clear();
        RecordFailureLocked(_clock());
        return new GpuLostException($"NVML: {st}");
    }

    private static bool IsLoss(NvmlStatus st) =>
        st is NvmlStatus.GpuIsLost or NvmlStatus.Uninitialized or NvmlStatus.InvalidArgument or NvmlStatus.ResetRequired or NvmlStatus.DriverNotLoaded;

    /// <summary>true: deger gecerli. NOT_SUPPORTED/diger: false (alan null). Kayip durumlari firlatir.</summary>
    private bool Ok(NvmlStatus st)
    {
        if (st == NvmlStatus.Success) return true;
        if (IsLoss(st)) throw LoseLocked(st);
        return false;
    }

    private IReadOnlyList<GpuDevice> DiscoverLocked()
    {
        _handles.Clear();
        var devices = new List<GpuDevice>();
        if (!Ok(_api.GetDeviceCount(out var count))) return devices;
        for (uint i = 0; i < count; i++)
        {
            if (!Ok(_api.GetHandleByIndex(i, out var h))) continue;
            if (!Ok(_api.GetUuid(h, out var uuid))) continue;
            string id;
            try { id = GpuCanonicalId.FromNvmlUuid(uuid); }
            catch (ArgumentException) { continue; } // MIG vb. beklenmeyen kimlik: atla
            var name = Ok(_api.GetName(h, out var n)) && n.Length > 0 ? n : "NVIDIA GPU";
            _handles[id] = h;
            _caps[id] = Probe(h);
            devices.Add(new GpuDevice(id, "NVIDIA", name, Id));
        }
        return devices;
    }

    /// <summary>Kesifte her alani bir kez dener: NOT_SUPPORTED olanlar yetenek bayragi almaz.</summary>
    private GpuCapabilities Probe(nint h)
    {
        var c = GpuCapabilities.None;
        if (Ok(_api.GetUtilization(h, out _))) c |= GpuCapabilities.Utilization;
        if (Ok(_api.GetMemory(h, out _, out _))) c |= GpuCapabilities.Vram;
        if (Ok(_api.GetTemperatureC(h, out _))) c |= GpuCapabilities.Temperature;
        if (Ok(_api.GetPowerMilliwatts(h, out _))) c |= GpuCapabilities.Power;
        if (Ok(_api.GetFanPercent(h, out _))) c |= GpuCapabilities.Fan;
        if (Ok(_api.GetCoreClockMHz(h, out _))) c |= GpuCapabilities.CoreClock;
        if (Ok(_api.GetMemClockMHz(h, out _))) c |= GpuCapabilities.MemClock;
        return c;
    }

    private GpuSample ReadLocked(nint h, GpuCapabilities caps)
    {
        double? util = null, temp = null, power = null, fan = null, core = null, mem = null;
        long? used = null, total = null;

        if (caps.HasFlag(GpuCapabilities.Utilization) && Ok(_api.GetUtilization(h, out var u))) util = NvmlValues.Percent(u);
        if (caps.HasFlag(GpuCapabilities.Vram) && Ok(_api.GetMemory(h, out var t, out var us))) (total, used) = NvmlValues.Memory(t, us);
        if (caps.HasFlag(GpuCapabilities.Temperature) && Ok(_api.GetTemperatureC(h, out var c))) temp = NvmlValues.TempC(c);
        if (caps.HasFlag(GpuCapabilities.Power) && Ok(_api.GetPowerMilliwatts(h, out var mw))) power = NvmlValues.PowerW(mw);
        if (caps.HasFlag(GpuCapabilities.Fan) && Ok(_api.GetFanPercent(h, out var f))) fan = NvmlValues.Percent(f);
        if (caps.HasFlag(GpuCapabilities.CoreClock) && Ok(_api.GetCoreClockMHz(h, out var cc))) core = NvmlValues.Clock(cc);
        if (caps.HasFlag(GpuCapabilities.MemClock) && Ok(_api.GetMemClockMHz(h, out var mc))) mem = NvmlValues.Clock(mc);

        _failures = 0; // basarili okuma: devre kesici sayaci sifirlanir
        _openUntil = DateTimeOffset.MinValue;
        return new GpuSample(util, used, total, temp, power, fan, core, mem);
    }
}

/// <summary>Birim donusumu ve dogrulama (tek yer). Gecersiz deger null olur; sessizce duzeltilmez.</summary>
internal static class NvmlValues
{
    public static double? Percent(uint v) => v <= 100 ? v : null;
    public static double? TempC(uint v) => v <= 200 ? v : null;
    public static double? PowerW(uint milliwatts) => milliwatts <= 10_000_000 ? milliwatts / 1000.0 : null; // <= 10 kW
    public static double? Clock(uint mhz) => mhz <= 100_000 ? mhz : null;

    /// <summary>(toplam, kullanilan): long'u asan toplam -> ikisi de null; kullanilan > toplam -> kullanilan null.</summary>
    public static (long? Total, long? Used) Memory(ulong total, ulong used)
    {
        if (total > long.MaxValue) return (null, null);
        long? u = used <= total ? (long)used : null;
        return ((long)total, u);
    }
}
