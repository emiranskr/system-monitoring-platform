namespace SysMon.Agent.Sensors;

/// <summary>Protokolde sabit sensor kimlikleri (bayt degerleri DEGISMEZ; yeni sensor yeni numara alir).</summary>
public enum SensorId : byte
{
    CpuPackageTempC = 1,
    CpuCoreMaxTempC = 2,
    MotherboardTempC = 3,
    CpuFanRpm = 4,
}

/// <summary>
/// Okunamama nedeni ayrilir (panelde "desteklenmiyor" ile "erisim engelli" karismasin).
/// Ok: deger gecerli. Digerlerinde deger her zaman 0'dir ve anlamsizdir.
/// </summary>
public enum SensorStatus : byte
{
    Ok = 0,
    Unavailable = 1,
    Unsupported = 2,
    PermissionDenied = 3,
    ProviderError = 4,
}

public readonly record struct SensorReading(SensorId Id, SensorStatus Status, double Value);

/// <summary>Bir sensorun birimi ve fiziksel olarak gecerli araligi.</summary>
public sealed record SensorSpecEntry(string Unit, double Min, double Max);

public static class SensorSpec
{
    private static readonly Dictionary<SensorId, SensorSpecEntry> Specs = new()
    {
        [SensorId.CpuPackageTempC] = new("C", -50, 200),
        [SensorId.CpuCoreMaxTempC] = new("C", -50, 200),
        [SensorId.MotherboardTempC] = new("C", -50, 200),
        [SensorId.CpuFanRpm] = new("rpm", 0, 100_000),
    };

    public static bool TryGet(SensorId id, out SensorSpecEntry spec) => Specs.TryGetValue(id, out spec!);

    /// <summary>Okumanin sema kurallarina uyup uymadigi (kodlayici ve cozucu AYNI kurali kullanir). Hata yoksa null.</summary>
    public static SensorProtocolError? Validate(SensorReading r)
    {
        if (!TryGet(r.Id, out var spec)) return SensorProtocolError.UnknownSensor;
        if (!Enum.IsDefined(r.Status)) return SensorProtocolError.BadStatus;
        if (r.Status == SensorStatus.Ok)
            return double.IsFinite(r.Value) && r.Value >= spec.Min && r.Value <= spec.Max ? null : SensorProtocolError.BadValue;
        return BitConverter.DoubleToInt64Bits(r.Value) == 0 ? null : SensorProtocolError.BadValue; // +0.0 disinda her sey (NaN, -0.0 dahil) reddedilir
    }
}

/// <summary>
/// Donanim sensoru kaynagi (ornegin LibreHardwareMonitor). Yalnizca ayri SensorHelper sureci icinde calisir;
/// ana agent bunu dogrudan yuklemez. Okuma sirasinda hata/destek yoklugu durum alani olarak doner.
/// </summary>
public interface ISensorProvider
{
    string Name { get; }
    Task<IReadOnlyList<SensorReading>> ReadAllAsync(CancellationToken ct);
}

/// <summary>Surucu/sensor yok: butun sensorler Unavailable. Uretim yardimcisinin (M4) varsayilan saglayicisi.</summary>
public sealed class NullSensorProvider : ISensorProvider
{
    public string Name => "null";

    public Task<IReadOnlyList<SensorReading>> ReadAllAsync(CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        IReadOnlyList<SensorReading> all = Enum.GetValues<SensorId>().Select(id => new SensorReading(id, SensorStatus.Unavailable, 0.0)).ToList();
        return Task.FromResult(all);
    }
}
