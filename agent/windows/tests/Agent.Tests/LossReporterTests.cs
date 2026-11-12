using SysMon.Agent.Transport;

namespace Agent.Tests;

/// <summary>I-3: yakalama yolundaki kayiplar (dusen ornek/batch, reddedilen ornek) ve Enqueue hatalari gorunur olmali.</summary>
public class LossReporterTests
{
    private DateTimeOffset _now = new(2026, 11, 12, 9, 0, 0, TimeSpan.Zero);
    private LossCounters _c = new(0, 0, 0);
    private readonly List<string> _warnings = [];
    private readonly List<(Exception Ex, int Suppressed)> _errors = [];

    private LossReporter Make(Action<string>? warn = null) =>
        new(() => _c, warn ?? _warnings.Add, (ex, n) => _errors.Add((ex, n)), () => _now, TimeSpan.FromSeconds(60));

    [Fact]
    public void Sayac_degismediyse_uyari_yazmaz()
    {
        var r = Make();
        r.CheckCounters();
        r.CheckCounters();
        Assert.Empty(_warnings);
    }

    [Fact]
    public void Sayac_artinca_kumulatif_degerlerle_bir_kez_uyarir_sonra_susar()
    {
        var r = Make();
        _c = new LossCounters(DroppedSamples: 5, RejectedSamples: 0, DroppedBatches: 2);
        r.CheckCounters();
        r.CheckCounters(); // degismedi

        var w = Assert.Single(_warnings);
        Assert.Contains("5", w);
        Assert.Contains("2", w);

        _c = new LossCounters(7, 3, 2);
        r.CheckCounters();
        Assert.Equal(2, _warnings.Count);
        Assert.Contains("7", _warnings[1]); // kumulatif
        Assert.Contains("3", _warnings[1]);
    }

    [Fact]
    public void Tekrarlayan_hatalar_aralik_icinde_tek_satira_indirilir_sonra_bastirilan_sayisi_bildirilir()
    {
        var r = Make();
        r.ReportError(new IOException("disk dolu"));
        r.ReportError(new IOException("disk dolu"));
        r.ReportError(new IOException("disk dolu"));
        Assert.Single(_errors);
        Assert.Equal(0, _errors[0].Suppressed);

        _now = _now.AddSeconds(61);
        r.ReportError(new IOException("disk dolu"));

        Assert.Equal(2, _errors.Count);
        Assert.Equal(2, _errors[1].Suppressed);
    }

    [Fact]
    public void Gunluk_yazma_hatasi_istisna_firlatmaz()
    {
        var r = new LossReporter(() => new LossCounters(1, 0, 0), _ => throw new IOException("log"),
            (_, _) => throw new IOException("log"), () => _now, TimeSpan.FromSeconds(60));

        r.CheckCounters();
        r.ReportError(new Exception("x"));
    }
}
