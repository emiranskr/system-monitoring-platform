using SysMon.Agent;
using SysMon.Agent.Collectors;

namespace Agent.Tests.Sensors;

/// <summary>
/// Sensor yardimcisinin servise baglanmasi: VARSAYILAN KAPALI, yalniz acik secenekle (--sensor-helper &lt;mutlak yol&gt;). Hatali/eksik/guvenilmez
/// yapilandirma GUVENLI BICIMDE kapali kalir (istisna yok, surec baslatilmaz, agent calismaya devam eder). UAC/surucu/yetki yukseltme yoktur.
/// </summary>
[Collection("SensorHelperProcess")]
public class SensorWiringTests
{
    private static string ProductionHelper() => Path.Combine(AppContext.BaseDirectory, "Agent.SensorHelper.exe");

    [Fact]
    public void Secenek_verilmezse_hicbir_sey_olusturulmaz_ve_hicbir_sey_loglanmaz()
    {
        var logs = new List<string>();
        var w = SensorWiring.TryCreate(AgentOptions.Parse([]), logs.Add, logs.Add);
        Assert.Null(w);
        Assert.Empty(logs);
    }

    [Fact]
    public void Secenek_ayristirilir_mutlak_yol_gerekir_ve_varsayilan_null()
    {
        Assert.Null(AgentOptions.Parse([]).SensorHelper);
        Assert.Equal(@"C:\Program Files\SysMon\Agent\Agent.SensorHelper.exe", AgentOptions.Parse(["--sensor-helper", @"C:\Program Files\SysMon\Agent\Agent.SensorHelper.exe"]).SensorHelper);
        Assert.Throws<ArgumentException>(() => AgentOptions.Parse(["--sensor-helper", @"gorece\yol.exe"]));
        Assert.Throws<ArgumentException>(() => AgentOptions.Parse(["--sensor-helper"]));
    }

    [Theory]
    [InlineData(@"C:\yok\boyle\bir\dosya\Agent.SensorHelper.exe")]               // yok
    [InlineData(@"C:\Windows\System32\drivers\etc\hosts")]                          // exe degil
    public async Task Gecersiz_yol_guvenli_bicimde_kapali_kalir_istisna_yok_uyari_var(string path)
    {
        var warns = new List<string>();
        var w = SensorWiring.TryCreate(new AgentOptions(false, false, SensorHelper: path), _ => { }, warns.Add);
        Assert.Null(w);
        Assert.Single(warns);
        Assert.DoesNotContain("exception", warns[0], StringComparison.OrdinalIgnoreCase);
        await Task.CompletedTask;
    }

    [Fact]
    public void Guvenilmeyen_izinli_yol_uretimde_REDDEDILIR_yazilabilir_dizin_sahip_guvenilir_degil()
    {
        // Gecici (kullanici-yazilabilir) dizindeki exe: uretim ayari (requireSecurePermissions: true) bunu reddeder.
        var dir = Path.Combine(Path.GetTempPath(), "sysmon-wiring-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        try
        {
            var exe = Path.Combine(dir, "Agent.SensorHelper.exe");
            File.Copy(ProductionHelper(), exe);
            var warns = new List<string>();
            var w = SensorWiring.TryCreate(new AgentOptions(false, false, SensorHelper: exe), _ => { }, warns.Add);
            Assert.Null(w);
            Assert.Single(warns);
        }
        finally { Directory.Delete(dir, true); }
    }

    [Fact]
    public async Task Gecerli_yardimci_acikca_etkinlestirilince_collector_olusur_ve_okuma_asla_firlatmaz_Dispose_sureci_oldurur()
    {
        var infos = new List<string>();
        // Test: guvenli izin denetimi KAPALI (CI/gelistirme dizini); uretim varsayilani true'dur (yukaridaki test).
        var w = SensorWiring.TryCreate(new AgentOptions(false, false, SensorHelper: ProductionHelper()), infos.Add, _ => { }, requireSecurePermissions: false);
        Assert.NotNull(w);
        try
        {
            Assert.Equal("sensors", w!.Collector.Name);
            using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(30));
            var values = await w.Collector.CollectAsync(cts.Token);       // gercek yardimci surec + pipe; Null saglayici: sensorler "kullanilamiyor"
            Assert.All(values.Values, v => Assert.Null(v));
        }
        finally { await w!.DisposeAsync(); }
        Assert.Contains(infos, m => m.Contains("etkin", StringComparison.OrdinalIgnoreCase));
    }
}
