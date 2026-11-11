using SysMon.Agent.Transport;

namespace Agent.Tests.Transport;

public sealed class SpoolTests : IDisposable
{
    private readonly string _dir = Path.Combine(Path.GetTempPath(), "sysmon-spool-" + Guid.NewGuid().ToString("N"));
    private DateTimeOffset _now = new(2026, 11, 11, 9, 0, 0, TimeSpan.Zero);

    public void Dispose()
    {
        if (Directory.Exists(_dir)) Directory.Delete(_dir, true);
    }

    private Spool Open(SpoolLimits? l = null) =>
        new(_dir, l ?? new SpoolLimits(MaxBytes: 50_000_000, MaxAge: TimeSpan.FromHours(24), SegmentBytes: 1_000_000), () => _now);

    private static IReadOnlyList<Sample> One(double v) =>
        [new Sample(new DateTimeOffset(2026, 11, 11, 9, 0, 0, TimeSpan.Zero), new Dictionary<string, double?> { ["cpu.total"] = v })];

    [Fact]
    public void Enqueue_yeniden_baslatmada_kalicidir()
    {
        var b = Open().Enqueue(One(11));
        var again = Open().PeekOldest();
        Assert.NotNull(again);
        Assert.Equal(b.Seq, again!.Seq);
        Assert.Equal(b.Epoch, again.Epoch);
        Assert.Equal(11, again.Samples[0].M["cpu.total"]);
    }

    [Fact]
    public void Seq_monoton_artar_ve_yeniden_baslatmada_devam_eder()
    {
        var s = Open();
        var a = s.Enqueue(One(1));
        var b = s.Enqueue(One(2));
        var c = Open().Enqueue(One(3));
        Assert.Equal(a.Seq + 1, b.Seq);
        Assert.Equal(b.Seq + 1, c.Seq);
        Assert.Equal(a.Epoch, c.Epoch);
    }

    [Fact]
    public void Ack_yalnizca_ackli_batchi_siler()
    {
        var s = Open();
        var a = s.Enqueue(One(1));
        var b = s.Enqueue(One(2));
        s.Ack(a);
        Assert.Equal(b.Seq, s.PeekOldest()!.Seq);
        Assert.Equal(1, s.PendingCount);
    }

    [Fact]
    public void Ack_yeniden_baslatmadan_sonra_da_gecerlidir()
    {
        var s = Open();
        var a = s.Enqueue(One(1));
        var b = s.Enqueue(One(2));
        s.Ack(a);
        Assert.Equal(b.Seq, Open().PeekOldest()!.Seq);
    }

    [Fact]
    public void Boyut_siniri_en_eski_segmenti_atar_ve_sayar()
    {
        var s = Open(new SpoolLimits(MaxBytes: 700, MaxAge: TimeSpan.FromHours(24), SegmentBytes: 1));
        for (var i = 0; i < 20; i++) s.Enqueue(One(i));
        Assert.True(s.DroppedBatches > 0);
        Assert.True(s.TotalBytes <= 700 + 400); // en son segment siniri asabilir
        var oldest = s.PeekOldest()!;
        Assert.True(oldest.Seq > 0);
    }

    [Fact]
    public void Yas_siniri_24_saatten_eski_batchi_atar()
    {
        var s = Open(new SpoolLimits(MaxBytes: 50_000_000, MaxAge: TimeSpan.FromHours(24), SegmentBytes: 1));
        s.Enqueue(One(1));
        _now = _now.AddHours(25);
        var fresh = s.Enqueue(One(2));
        Assert.Equal(1, s.DroppedBatches);
        Assert.Equal(fresh.Seq, s.PeekOldest()!.Seq);
    }

    [Fact]
    public void Yarim_yazilmis_son_satir_atlanir()
    {
        var s = Open();
        var a = s.Enqueue(One(1));
        var seg = Directory.GetFiles(_dir, "seg-*.jsonl").Single();
        File.AppendAllText(seg, "{\"Epoch\":\"yarim");
        var reopened = Open();
        Assert.Equal(a.Seq, reopened.PeekOldest()!.Seq);
        Assert.Equal(1, reopened.PendingCount);
    }

    [Fact]
    public void Bozuk_durum_dosyasi_yeni_epoch_uretir_ama_batchler_okunur()
    {
        var s = Open();
        var a = s.Enqueue(One(1));
        File.WriteAllText(Path.Combine(_dir, "state.json"), "{bozuk");
        var reopened = Open();
        var pending = reopened.PeekOldest()!;
        Assert.Equal(a.Epoch, pending.Epoch); // eski batch kendi epoch'unu korur
        var fresh = reopened.Enqueue(One(2));
        Assert.NotEqual(a.Epoch, fresh.Epoch);
        Assert.Equal(0, fresh.Seq);
    }

    [Fact]
    public void Saat_ofseti_kalicidir()
    {
        var s = Open();
        s.SetClockOffset(TimeSpan.FromSeconds(42));
        Assert.Equal(TimeSpan.FromSeconds(42), Open().ClockOffset);
    }
}
