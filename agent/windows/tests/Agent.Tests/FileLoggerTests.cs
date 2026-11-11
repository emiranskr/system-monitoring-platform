using Microsoft.Extensions.Logging;
using SysMon.Agent;

namespace Agent.Tests;

public sealed class FileLoggerTests : IDisposable
{
    private readonly string _dir = Path.Combine(Path.GetTempPath(), "sysmon-log-" + Guid.NewGuid().ToString("N"));
    private string LogPath => Path.Combine(_dir, "logs", "agent.log");

    public void Dispose()
    {
        if (Directory.Exists(_dir)) Directory.Delete(_dir, true);
    }

    [Fact]
    public void Mesaj_seviye_kategori_ve_istisna_dosyaya_yazilir()
    {
        using var p = new FileLoggerProvider(LogPath);
        var log = p.CreateLogger("Deneme.Kategori");
        log.LogError(new InvalidOperationException("patladi-xyz"), "kritik durum {Deger}", 42);

        var text = File.ReadAllText(LogPath);
        Assert.Contains("[Error]", text);
        Assert.Contains("Deneme.Kategori", text);
        Assert.Contains("kritik durum 42", text);
        Assert.Contains("InvalidOperationException", text);
        Assert.Contains("patladi-xyz", text);
    }

    [Fact]
    public void Information_alti_seviyeler_yazilmaz()
    {
        using var p = new FileLoggerProvider(LogPath);
        var log = p.CreateLogger("x");
        log.LogDebug("gizli-debug");
        log.LogInformation("gorunur-bilgi");
        var text = File.ReadAllText(LogPath);
        Assert.DoesNotContain("gizli-debug", text);
        Assert.Contains("gorunur-bilgi", text);
    }

    [Fact]
    public void Boyut_siniri_asilinca_dosya_doner_ve_eski_veri_korunur()
    {
        using var p = new FileLoggerProvider(LogPath, maxBytes: 2000);
        var log = p.CreateLogger("x");
        for (var i = 0; i < 100; i++) log.LogInformation("satir-{I}-{Dolgu}", i, new string('a', 40));

        Assert.True(File.Exists(LogPath + ".1"), "donen dosya olusmadi");
        Assert.True(new FileInfo(LogPath).Length <= 2000 + 200, "ana dosya sinirin cok ustunde");
        Assert.Contains("satir-99-", File.ReadAllText(LogPath));
    }

    [Fact]
    public async Task Eszamanli_yazimda_satirlar_bozulmaz()
    {
        using var p = new FileLoggerProvider(LogPath, maxBytes: 50_000_000);
        var log = p.CreateLogger("x");
        await Task.WhenAll(Enumerable.Range(0, 8).Select(t => Task.Run(() =>
        {
            for (var i = 0; i < 50; i++) log.LogInformation("t{T}-i{I}-SON", t, i);
        })));

        var lines = File.ReadAllLines(LogPath).Where(l => l.Contains("-SON")).ToList();
        Assert.Equal(400, lines.Count);
        Assert.All(lines, l => Assert.Matches(@"\[Information\] x: t\d-i\d+-SON$", l));
    }

    [Fact]
    public void Yazilamayan_yolda_log_cagrisi_istisna_firlatmaz()
    {
        var bad = Path.Combine(_dir, "con", "agent.log"); // dizin olusturulamaz hale getir
        Directory.CreateDirectory(_dir);
        File.WriteAllText(Path.Combine(_dir, "con"), "dosya"); // 'con' bir dosya: altinda dizin acilamaz
        using var p = new FileLoggerProvider(bad);
        var ex = Record.Exception(() => { p.CreateLogger("x").LogError("yutulmali"); });
        Assert.Null(ex);
    }
}
