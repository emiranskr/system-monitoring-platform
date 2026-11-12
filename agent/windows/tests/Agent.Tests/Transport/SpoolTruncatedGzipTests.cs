using SysMon.Agent.Transport;

namespace Agent.Tests.Transport;

/// <summary>Kesik/bozuk gzip segment acilista istisna firlatmamali; okunabilen kisim kullanilmali.</summary>
public sealed class SpoolTruncatedGzipTests : IDisposable
{
    private readonly string _dir = Path.Combine(Path.GetTempPath(), "sysmon-gz-" + Guid.NewGuid().ToString("N"));
    private readonly DateTimeOffset _now = new(2026, 11, 12, 9, 0, 0, TimeSpan.Zero);

    public void Dispose()
    {
        if (Directory.Exists(_dir)) Directory.Delete(_dir, true);
    }

    private Spool Open() => new(_dir, new SpoolLimits(50_000_000, TimeSpan.FromHours(24), SegmentBytes: 2_000), () => _now);

    private string SealedGzip()
    {
        var spool = Open();
        for (var i = 0; i < 40; i++)
            spool.Enqueue([new Sample(_now, new Dictionary<string, double?> { ["cpu.total"] = i, ["mem.used_pct"] = i * 2 })]);
        var gz = Directory.GetFiles(_dir, "seg-*.jsonl.gz").OrderBy(p => p).First();
        Assert.True(new FileInfo(gz).Length > 40, "test varsayimi: muhurlu gz segment olusmus olmali");
        return gz;
    }

    private void AssertSpoolSurvives()
    {
        var reopened = Record.Exception(() => Open());
        Assert.Null(reopened);

        var again = Open();
        Assert.Null(Record.Exception(() => again.PeekOldest()));
        again.Enqueue([new Sample(_now, new Dictionary<string, double?> { ["cpu.total"] = 999 })]); // yazma yolu da saglam
    }

    [Fact]
    public void Kesik_gzip_segment_acilista_istisna_firlatmaz_ve_spool_calismaya_devam_eder()
    {
        var gz = SealedGzip();
        using (var fs = new FileStream(gz, FileMode.Open, FileAccess.Write, FileShare.None)) fs.SetLength(new FileInfo(gz).Length / 2);

        AssertSpoolSurvives();
    }

    /// <summary>
    /// .NET kesik gzip'i hatasiz erken-bitmis sayar; InvalidDataException YALNIZCA bozuk (gecersiz deflate) icerikte olusur.
    /// Bu test ReadLines'taki InvalidDataException yakalamasini gercekten sinar (yakalama kalkinca kirilir).
    /// </summary>
    [Fact]
    public void Bozuk_icerikli_gzip_segment_acilista_istisna_firlatmaz_ve_spool_calismaya_devam_eder()
    {
        var gz = SealedGzip();
        var bytes = File.ReadAllBytes(gz);
        for (var i = 12; i < Math.Min(bytes.Length, 40); i++) bytes[i] = 0xFF; // baslik sonrasi deflate akisini boz
        File.WriteAllBytes(gz, bytes);

        AssertSpoolSurvives();
    }
}
