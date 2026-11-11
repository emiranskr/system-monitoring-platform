using System.Text.Json.Nodes;
using SysMon.Agent.Transport;

namespace Agent.Tests.Transport;

/// <summary>Bagimsiz kod incelemesi (M1) bulgularinin regresyon testleri: K1, K3, O2, O3, O4.</summary>
[Collection("NonParallelSpoolMemory")]
public sealed class SpoolReviewTests : IDisposable
{
    private readonly string _dir = Path.Combine(Path.GetTempPath(), "sysmon-rev-" + Guid.NewGuid().ToString("N"));
    private DateTimeOffset _now = new(2026, 11, 11, 9, 0, 0, TimeSpan.Zero);

    public void Dispose()
    {
        if (Directory.Exists(_dir)) Directory.Delete(_dir, true);
    }

    private Spool Open(SpoolLimits? l = null, Action<int>? onDropped = null) =>
        new(_dir, l ?? new SpoolLimits(50_000_000, TimeSpan.FromHours(24), 1_000_000), () => _now, onDropped);

    private static IReadOnlyList<Sample> One(double v) =>
        [new Sample(new DateTimeOffset(2026, 11, 11, 9, 0, 0, TimeSpan.Zero), new Dictionary<string, double?> { ["cpu.total"] = v })];

    [Fact]
    public void K1_Ack_kuyrukta_olmayan_batch_icin_hicbir_seye_dokunmaz()
    {
        var s = Open(new SpoolLimits(MaxBytes: 700, MaxAge: TimeSpan.FromHours(24), SegmentBytes: 1));
        var first = s.Enqueue(One(0));
        for (var i = 1; i < 20; i++) s.Enqueue(One(i)); // limit nedeniyle ilk segmentler atildi
        Assert.True(s.DroppedBatches > 0);
        var pending = s.PendingCount;
        var oldest = s.PeekOldest()!;
        Assert.True(oldest.Seq > first.Seq, "ilk batch atilmis olmali");

        s.Ack(first); // uploader ucustayken atilan batch icin gec gelen ack

        Assert.Equal(pending, s.PendingCount);
        Assert.Equal(oldest.Seq, s.PeekOldest()!.Seq);
    }

    [Fact]
    public void K3_Acilista_tum_batchler_bellege_yuklenmez_yalnizca_indeks_tutulur()
    {
        var s = Open();
        for (var i = 0; i < 3000; i++)
        {
            var samples = Enumerable.Range(0, 10).Select(k => new Sample(
                new DateTimeOffset(2026, 11, 11, 9, 0, 0, TimeSpan.Zero).AddSeconds(i * 10 + k),
                new Dictionary<string, double?>
                {
                    ["cpu.total"] = i + k, ["mem.used_pct"] = 50.5, ["mem.used_bytes"] = 8e9 + i, ["mem.total_bytes"] = 2.4e10,
                    ["disk.C.used_pct"] = 71.5, ["net.Ethernet.rx_bps"] = 1000 + k, ["net.Ethernet.tx_bps"] = 500 + k,
                })).ToList();
            s.Enqueue(samples);
        }
        s = null;
        var before = GC.GetTotalMemory(true);
        var reopened = Open();
        var after = GC.GetTotalMemory(true);

        Assert.Equal(3000, reopened.PendingCount);
        Assert.True(after - before < 3_000_000, $"acilista bellek artisi cok yuksek: {(after - before) / 1_000_000.0:0.0} MB (tum batchler yuklenmis olabilir)");
        // yine de ilk batch dogru okunur
        Assert.Equal(0, reopened.PeekOldest()!.Seq);
        GC.KeepAlive(reopened);
    }

    [Fact]
    public void O2_Yarim_yazilmis_satirdan_sonra_eklenen_batch_bozulmaz()
    {
        var s = Open();
        var a = s.Enqueue(One(1));
        var seg = Directory.GetFiles(_dir, "seg-*.jsonl").Single();
        File.AppendAllText(seg, "{\"Epoch\":\"yarim-yazilmis-satir-newline-yok"); // cokme: satir sonu yok

        var reopened = Open();
        var b = reopened.Enqueue(One(2));
        var again = Open();

        Assert.Equal(2, again.PendingCount);
        Assert.Equal(a.Seq, again.PeekOldest()!.Seq);
        again.Ack(a);
        Assert.Equal(b.Seq, again.PeekOldest()!.Seq);
        Assert.Equal(2, again.PeekOldest()!.Samples[0].M["cpu.total"]);
    }

    [Fact]
    public void O3_Eski_state_json_ile_acilista_seq_yeniden_kullanilmaz()
    {
        var s = Open();
        for (var i = 0; i < 3; i++) s.Enqueue(One(i));
        var statePath = Path.Combine(_dir, "state.json");
        var node = JsonNode.Parse(File.ReadAllText(statePath))!;
        node["NextSeq"] = 0; // yedekten/kayip yazimdan eski durum
        File.WriteAllText(statePath, node.ToJsonString());

        var reopened = Open();
        var fresh = reopened.Enqueue(One(99));

        Assert.Equal(3, fresh.Seq);
        Assert.Equal(4, reopened.PendingCount);
    }

    [Fact]
    public void O4_Tek_segmentte_eski_veri_yeni_batchi_silmez_ve_sayac_degismez()
    {
        var s = Open();
        var a = s.Enqueue(One(1));
        _now = _now.AddHours(25); // saat duzeltmesi/atlamasi: eski batch artik 24 saatten eski gorunuyor
        var b = s.Enqueue(One(2));

        Assert.Equal(0, s.DroppedBatches);
        Assert.Equal(2, s.PendingCount);
        Assert.Equal(a.Seq, s.PeekOldest()!.Seq);
        Assert.Equal(b.Seq, b.Seq);
    }

    [Fact]
    public void O4_Atilan_batch_sayisi_geri_cagriyla_bildirilir()
    {
        var dropped = 0;
        var s = Open(new SpoolLimits(MaxBytes: 700, MaxAge: TimeSpan.FromHours(24), SegmentBytes: 1), n => dropped += n);
        for (var i = 0; i < 20; i++) s.Enqueue(One(i));
        Assert.True(s.DroppedBatches > 0);
        Assert.Equal(s.DroppedBatches, dropped);
    }

    [Fact]
    public void Yuklenemeyen_bozuk_segmentteki_indeks_olsa_bile_PeekOldest_dongude_takilmaz()
    {
        var s = Open(new SpoolLimits(50_000_000, TimeSpan.FromHours(24), 1));
        s.Enqueue(One(1));
        var b = s.Enqueue(One(2));
        var first = Directory.GetFiles(_dir, "seg-*").OrderBy(f => f).First();
        File.Delete(first); // disk uzerinden kayboldu (ornegin antivirus/elle silme)

        var peek = s.PeekOldest(); // indeks var, veri yok -> atlanip sonrakine gecilmeli
        Assert.NotNull(peek);
        Assert.Equal(b.Seq, peek!.Seq);
    }
}
