using SysMon.Agent.Collectors;

namespace SysMon.Agent.Sensors;

/// <summary>
/// Sensor okumalarini ICollector hattina baglar (kaynak: <c>SensorSupervisor.ReadAsync</c> — yardimci arizasinda zaten Unavailable doner).
/// Yalniz <see cref="SensorStatus.Ok"/> okumalar metrik olur (<c>sensor.&lt;ad&gt;</c>); diger durumlar yayinlanmaz, bu da grafikte kesinti
/// (bosluk) olarak gorunur: sifir uydurulmaz. Okuyucu hata verirse bos sonuc doner (agent sagligi sensore bagli degildir).
/// </summary>
public sealed class SensorCollector(Func<CancellationToken, Task<IReadOnlyList<SensorReading>>> read, TimeSpan interval) : ICollector
{
    public string Name => "sensors";
    public TimeSpan Interval => interval;

    private static readonly Dictionary<SensorId, string> Names = new()
    {
        [SensorId.CpuPackageTempC] = "sensor.cpu_package_temp_c",
        [SensorId.CpuCoreMaxTempC] = "sensor.cpu_core_max_temp_c",
        [SensorId.MotherboardTempC] = "sensor.motherboard_temp_c",
        [SensorId.CpuFanRpm] = "sensor.cpu_fan_rpm",
    };

    public async Task<IReadOnlyDictionary<string, double?>> CollectAsync(CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        var result = new Dictionary<string, double?>();
        IReadOnlyList<SensorReading> readings;
        try { readings = await read(ct).ConfigureAwait(false); }
        catch (OperationCanceledException) when (ct.IsCancellationRequested) { throw; }
        catch (Exception) { return result; }

        foreach (var r in readings)
            if (r.Status == SensorStatus.Ok && Names.TryGetValue(r.Id, out var name)) result[name] = r.Value;
        return result;
    }
}
