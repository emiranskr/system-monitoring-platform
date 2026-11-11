using System.IO.Compression;
using SysMon.Agent.Transport;

namespace Agent.Tests.Transport;

public sealed class SpoolCompressionTests : IDisposable
{
    private readonly string _dir = Path.Combine(Path.GetTempPath(), "sysmon-spz-" + Guid.NewGuid().ToString("N"));
    private DateTimeOffset _now = new(2026, 11, 11, 9, 0, 0, TimeSpan.Zero);

    public void Dispose()
    {
        if (Directory.Exists(_dir)) Directory.Delete(_dir, true);
    }

    private Spool Open(long segmentBytes = 4000) =>
        new(_dir, new SpoolLimits(50_000_000, TimeSpan.FromHours(24), segmentBytes), () => _now);

    private static IReadOnlyList<Sample> Realistic(int i)
    {
        var list = new List<Sample>();
        for (var k = 0; k < 5; k++)
        {
            list.Add(new Sample(new DateTimeOffset(2026, 11, 11, 9, 0, 0, TimeSpan.Zero).AddSeconds(i * 5 + k),
                new Dictionary<string, double?>
                {
                    ["cpu.total"] = 10 + (i + k) % 7,
                    ["mem.used_pct"] = 50.1234 + (i % 3),
                    ["mem.used_bytes"] = 8_000_000_000 + i,
                    ["mem.total_bytes"] = 24_000_000_000,
                    ["disk.C.used_pct"] = 71.5,
                    ["net.Ethernet.rx_bps"] = 1000 * k,
                    ["net.Ethernet.tx_bps"] = 500 * k,
                }));
        }
        return list;
    }

    [Fact]
    public void Muhurlenen_segmentler_gzip_olur_yalnizca_aktif_segment_duz_kalir()
    {
        var s = Open();
        for (var i = 0; i < 60; i++) s.Enqueue(Realistic(i));

        var gz = Directory.GetFiles(_dir, "seg-*.jsonl.gz");
        var raw = Directory.GetFiles(_dir, "seg-*.jsonl");
        Assert.NotEmpty(gz);
        Assert.Single(raw); // yalnizca aktif segment
    }

    [Fact]
    public void Sikistirma_yinelenen_metrik_JSON_icin_en_az_4_kat_kucultur()
    {
        var s = Open();
        for (var i = 0; i < 300; i++) s.Enqueue(Realistic(i));

        long rawBytes = 0;
        foreach (var f in Directory.GetFiles(_dir, "seg-*.jsonl.gz"))
        {
            using var gz = new GZipStream(File.OpenRead(f), CompressionMode.Decompress);
            using var ms = new MemoryStream();
            gz.CopyTo(ms);
            rawBytes += ms.Length;
        }
        var gzBytes = Directory.GetFiles(_dir, "seg-*.jsonl.gz").Sum(f => new FileInfo(f).Length);
        Assert.True(gzBytes * 4 < rawBytes, $"sikistirma orani yetersiz: {gzBytes} / {rawBytes}");
    }

    [Fact]
    public void Yeniden_baslatmada_gz_ve_duz_segmentlerin_tum_batchleri_sirayla_okunur()
    {
        var s = Open();
        var sent = Enumerable.Range(0, 80).Select(i => s.Enqueue(Realistic(i)).Seq).ToList();

        var reopened = Open();
        var seen = new List<long>();
        for (var b = reopened.PeekOldest(); b is not null; b = reopened.PeekOldest())
        {
            seen.Add(b.Seq);
            reopened.Ack(b);
        }
        Assert.Equal(sent, seen);
    }

    [Fact]
    public void Cokme_artigi_ayni_indeksli_duz_ve_gz_varsa_batchler_tekrarlanmaz_ve_duz_dosya_silinir()
    {
        var s = Open();
        for (var i = 0; i < 40; i++) s.Enqueue(Realistic(i));
        var gzFile = Directory.GetFiles(_dir, "seg-*.jsonl.gz").OrderBy(f => f).First();

        // Sikistirma tamamlandi ama duz dosyanin silinmesinden once cokme: ikisi de var.
        var rawTwin = gzFile[..^3];
        using (var gz = new GZipStream(File.OpenRead(gzFile), CompressionMode.Decompress))
        using (var outFs = File.Create(rawTwin))
            gz.CopyTo(outFs);

        var expected = Open().PendingCount; // yeniden acilis
        var total = 0;
        var reopened = Open();
        for (var b = reopened.PeekOldest(); b is not null; b = reopened.PeekOldest()) { total++; reopened.Ack(b); }

        Assert.Equal(40, total);
        Assert.Equal(40, expected);
        Assert.False(File.Exists(rawTwin));
    }

    [Fact]
    public void Yarim_kalmis_gz_tmp_dosyasi_acilista_silinir_ve_veri_kaybolmaz()
    {
        var s = Open();
        for (var i = 0; i < 30; i++) s.Enqueue(Realistic(i));
        File.WriteAllBytes(Path.Combine(_dir, "seg-00000099.jsonl.gz.tmp"), new byte[] { 1, 2, 3 });

        var reopened = Open();
        Assert.Equal(30, reopened.PendingCount);
        Assert.Empty(Directory.GetFiles(_dir, "*.tmp"));
    }

    [Fact]
    public void Gz_ile_acilan_son_segmente_ekleme_yapilmaz_yeni_segment_acilir()
    {
        var s = Open(segmentBytes: 1); // her batch yeni segment
        s.Enqueue(Realistic(0));
        s.Enqueue(Realistic(1));
        var reopened = Open(segmentBytes: 10_000_000);
        reopened.Enqueue(Realistic(2));

        var all = new List<long>();
        for (var b = reopened.PeekOldest(); b is not null; b = reopened.PeekOldest()) { all.Add(b.Seq); reopened.Ack(b); }
        Assert.Equal(new long[] { 0, 1, 2 }, all);
    }
}
