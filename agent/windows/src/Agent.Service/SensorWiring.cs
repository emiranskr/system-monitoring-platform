using System.Runtime.Versioning;
using System.Security.Principal;
using SysMon.Agent.Collectors;
using SysMon.Agent.Sensors;

namespace SysMon.Agent;

/// <summary>
/// Sensor yardimci surecinin (Agent.SensorHelper) agent'a baglanmasi. VARSAYILAN KAPALI: yalniz `--sensor-helper &lt;mutlak yol&gt;` ile etkinlesir.
/// Eksik/gecersiz/guvenilmez yapilandirma (yol yok, exe degil, yeniden-ayrisma noktasi, yazilabilir/sahibi guvenilmez dizin) GUVENLI BICIMDE kapali kalir:
/// istisna firlatilmaz, surec baslatilmaz, agent CPU/RAM/disk/ag/GPU izlemeye devam eder. Yetki yukseltme, surucu yukleme ve UAC YOKTUR; yardimci
/// agent'in kendi (dusuk yetkili) hesabiyla, Job Object icinde, rastgele adli ve ACL'li pipe ile calisir. NOT: gercek LibreHardwareMonitor/PawnIO
/// entegrasyonu YOKTUR; uretim yardimcisi yalniz NullSensorProvider kullanir (tum sensorler "kullanilamiyor").
/// </summary>
[SupportedOSPlatform("windows")]
public sealed class SensorWiring : IAsyncDisposable
{
    private readonly SensorSupervisor _supervisor;

    public ICollector Collector { get; }

    private SensorWiring(SensorSupervisor supervisor, ICollector collector)
    {
        _supervisor = supervisor;
        Collector = collector;
    }

    /// <summary>Secenek yoksa veya yapilandirma guvenli degilse null (ve yalniz secenek VARSA uyari loglanir).</summary>
    public static SensorWiring? TryCreate(AgentOptions options, Action<string> info, Action<string> warn, bool requireSecurePermissions = true)
    {
        if (options.SensorHelper is not { } path) return null;
        try
        {
            HelperExeValidator.Validate(path, requireSecurePermissions);
            var me = WindowsIdentity.GetCurrent().User ?? throw new InvalidOperationException("kullanici SID'i yok");
            var launcher = new ProcessHelperLauncher(path, me, Environment.ProcessId, requireSecurePermissions);
            var supervisor = new SensorSupervisor(launcher, SupervisorOptions.Default);
            var collector = new SensorCollector(supervisor.ReadAsync, TimeSpan.FromSeconds(5));
            info($"Sensor yardimcisi etkin: {path} (yalniz NullSensorProvider; gercek LHM/PawnIO entegrasyonu yok).");
            return new SensorWiring(supervisor, collector);
        }
        catch (Exception e) when (e is HelperExeException or InvalidOperationException or ArgumentException or UnauthorizedAccessException or IOException)
        {
            warn($"Sensor yardimcisi etkinlestirilemedi, KAPALI kalacak: {(e is HelperExeException h ? "yardimci reddedildi (" + h.Error + ")" : "yapilandirma gecersiz")}.");
            return null;
        }
    }

    public ValueTask DisposeAsync() => _supervisor.DisposeAsync();
}
