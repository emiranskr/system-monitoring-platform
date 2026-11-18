using SysMon.Agent.Sensors;

namespace Agent.Tests.Sensors;

/// <summary>Bagimsiz inceleme (M4) I-2: aralik sinirlari ve kanonik sifir.</summary>
public class SensorSpecBoundaryTests
{
    [Fact]
    public void Aralik_sinirlari_dahil_bir_otesi_reddedilir()
    {
        Assert.Null(SensorSpec.Validate(new(SensorId.CpuPackageTempC, SensorStatus.Ok, -50)));
        Assert.Null(SensorSpec.Validate(new(SensorId.CpuPackageTempC, SensorStatus.Ok, 200)));
        Assert.Equal(SensorProtocolError.BadValue, SensorSpec.Validate(new(SensorId.CpuPackageTempC, SensorStatus.Ok, -50.0001)));
        Assert.Equal(SensorProtocolError.BadValue, SensorSpec.Validate(new(SensorId.CpuPackageTempC, SensorStatus.Ok, 200.0001)));
        Assert.Null(SensorSpec.Validate(new(SensorId.CpuFanRpm, SensorStatus.Ok, 0)));
        Assert.Null(SensorSpec.Validate(new(SensorId.CpuFanRpm, SensorStatus.Ok, 100_000)));
        Assert.Equal(SensorProtocolError.BadValue, SensorSpec.Validate(new(SensorId.CpuFanRpm, SensorStatus.Ok, -0.0001)));
    }

    [Fact]
    public void Ok_olmayan_durumda_eksi_sifir_da_reddedilir_yalniz_pozitif_sifir_kanonik()
    {
        Assert.Null(SensorSpec.Validate(new(SensorId.CpuFanRpm, SensorStatus.Unavailable, 0.0)));
        Assert.Equal(SensorProtocolError.BadValue, SensorSpec.Validate(new(SensorId.CpuFanRpm, SensorStatus.Unavailable, -0.0)));
    }
}
