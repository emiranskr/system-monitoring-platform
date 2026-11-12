using SysMon.Agent.Transport;

namespace Agent.Tests.Transport;

/// <summary>Bagimsiz inceleme I-2: yarim/basarisiz append sonraki batch'i sessizce kaybettirmemeli; dusen ref'ler sayilmali.</summary>
public sealed class SpoolPartialWriteTests : IDisposable
{
    private readonly string _dir = Path.Combine(Path.GetTempPath(), "sysmon-pw-" + Guid.NewGuid().ToString("N"));
    private readonly DateTimeOffset _now = new(2026, 11, 12, 9, 0, 0, TimeSpan.Zero);

    public void Dispose()
    {
        if (Directory.Exists(_dir)) Directory.Delete(_dir, true);
    }

    private Spool Open(Action<int>? onDropped = null) =>
        new(_dir, new SpoolLimits(50_000_000, TimeSpan.FromHours(24), 1_000_000), () => _now, onDropped);

    private IReadOnlyList<Sample> One(double v) =>
        [new Sample(_now, new Dictionary<string, double?> { ["cpu.total"] = v })];

    private string ActiveSegment() => Directory.GetFiles(_dir, "seg-*.jsonl").Single();

    private static double Value(Batch b) => b.Samples[0].M["cpu.total"]!.Value;

    [Fact]
    public void Yarim_satir_kalintisindan_sonra_Enqueue_batchi_kaybetmez()
    {
        var spool = Open();
        var a = spool.Enqueue(One(1));
        File.AppendAllText(ActiveSegment(), "{\"Epoch\":\"yarim"); // '\n'siz kalinti (basarisiz yazma sonrasi gibi)

        var b = spool.Enqueue(One(2));

        Assert.Equal(a.Seq, spool.PeekOldest()!.Seq);
        spool.Ack(a);
        var head = spool.PeekOldest();
        Assert.NotNull(head);
        Assert.Equal(b.Seq, head.Seq);
        Assert.Equal(2, Value(head));
        Assert.Equal(0, spool.DroppedBatches);
    }

    [Fact]
    public void Yeniden_acilista_kalinti_olsa_bile_iki_batch_da_okunur_restart_recovery()
    {
        var spool = Open();
        spool.Enqueue(One(1));
        File.AppendAllText(ActiveSegment(), "{\"Epoch\":\"yarim");
        spool.Enqueue(One(2));

        var reopened = Open();

        Assert.Equal(2, reopened.PendingCount);
        Assert.Equal(1, Value(reopened.PeekOldest()!));
        reopened.Ack(reopened.PeekOldest()!);
        Assert.Equal(2, Value(reopened.PeekOldest()!));
    }

    [Fact]
    public void Basarisiz_Enqueue_dosyayi_bozmaz_ve_yeniden_deneme_tek_kayit_uretir_seq_bosluksuz()
    {
        var spool = Open();
        var a = spool.Enqueue(One(1));
        var seg = ActiveSegment();
        var before = new FileInfo(seg).Length;

        using (new FileStream(seg, FileMode.Open, FileAccess.Read, FileShare.None)) // yazmayi engelle
        {
            Assert.ThrowsAny<IOException>(() => spool.Enqueue(One(2)));
        }
        Assert.Equal(before, new FileInfo(seg).Length);
        Assert.Equal(1, spool.PendingCount);

        var b = spool.Enqueue(One(2)); // yeniden deneme (pipeline ayni ornekleri tekrar verir)

        Assert.Equal(a.Seq + 1, b.Seq);
        Assert.Equal(2, spool.PendingCount);
        var first = spool.PeekOldest()!;
        spool.Ack(first);
        Assert.Equal(2, Value(spool.PeekOldest()!));
        spool.Ack(spool.PeekOldest()!);
        Assert.Null(spool.PeekOldest());
    }

    [Fact]
    public void Diskten_kaybolan_segmentin_refleri_sayilir_ve_bildirilir()
    {
        var dropped = new List<int>();
        var spool = Open(dropped.Add);
        spool.Enqueue(One(1));
        File.Delete(ActiveSegment());

        Assert.Null(spool.PeekOldest());

        Assert.Equal(1, spool.DroppedBatches);
        Assert.Equal([1], dropped);
        Assert.Equal(0, spool.PendingCount);
    }
}
