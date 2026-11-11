using SysMon.Agent;
using SysMon.Agent.Transport;

namespace Agent.Tests.Transport;

/// <summary>
/// Gercek TLS (Kestrel, kendinden imzali sertifika) ile SPKI sabitleme ve uca-uca yukleme.
/// Debug ve Release'te AYNI sekilde calisir: Release'te duz HTTP yasak oldugundan yalnizca https kullanilir.
/// </summary>
public sealed class TlsPinningTests : IAsyncDisposable
{
    private readonly string _dir = Path.Combine(Path.GetTempPath(), "sysmon-tls-" + Guid.NewGuid().ToString("N"));
    private readonly TestHttpsServer _srv = new();
    private DateTimeOffset _now = new(2026, 11, 11, 9, 0, 0, TimeSpan.Zero);

    public async ValueTask DisposeAsync()
    {
        await _srv.DisposeAsync();
        if (Directory.Exists(_dir)) Directory.Delete(_dir, true);
    }

    private Spool NewSpool() =>
        new(_dir, new SpoolLimits(50_000_000, TimeSpan.FromHours(24), 1_000_000), () => _now);

    private Uploader NewUploader(Spool s, IReadOnlyList<string>? pins) =>
        new(s, HttpClients.Create(pins), _srv.Url, () => "tok-123", AgentOptions.Parse([]), () => _now);

    private static IReadOnlyList<Sample> One(double v) =>
        [new Sample(new DateTimeOffset(2026, 11, 11, 9, 0, 0, TimeSpan.Zero), new Dictionary<string, double?> { ["cpu.total"] = v })];

    [Fact]
    public void SpkiPin_bicimi_sha256_slash_base64()
    {
        var pin = SpkiPin.Compute(_srv.Cert);
        Assert.StartsWith("sha256/", pin);
        Assert.Equal(32, Convert.FromBase64String(pin["sha256/".Length..]).Length);
    }

    [Fact]
    public async Task Dogru_pin_ile_kendinden_imzali_sunucuya_yukleme_basarili_olur()
    {
        await _srv.StartAsync();
        var spool = NewSpool();
        spool.Enqueue(One(1));

        var outcome = await NewUploader(spool, [SpkiPin.Compute(_srv.Cert)]).UploadOnceAsync(default);

        Assert.Equal(UploadOutcome.Acked, outcome);
        Assert.Null(spool.PeekOldest());
        Assert.Equal("Bearer tok-123", _srv.AuthHeaders.Single());
    }

    [Fact]
    public async Task Yanlis_pin_TlsRejected_doner_veri_gonderilmez_ve_spool_korunur()
    {
        await _srv.StartAsync();
        var spool = NewSpool();
        spool.Enqueue(One(1));
        var wrong = "sha256/" + Convert.ToBase64String(new byte[32]);

        var outcome = await NewUploader(spool, [wrong]).UploadOnceAsync(default);

        Assert.Equal(UploadOutcome.TlsRejected, outcome);
        Assert.Equal(1, spool.PendingCount);
        Assert.Empty(_srv.Bodies); // token ve veri sertifika dogrulanmadan gonderilmemeli
        Assert.Empty(_srv.AuthHeaders);
    }

    [Fact]
    public async Task Pin_yoksa_kendinden_imzali_sertifika_sistem_dogrulamasiyla_reddedilir()
    {
        await _srv.StartAsync();
        var spool = NewSpool();
        spool.Enqueue(One(1));

        var outcome = await NewUploader(spool, null).UploadOnceAsync(default);

        Assert.Equal(UploadOutcome.TlsRejected, outcome);
        Assert.Empty(_srv.AuthHeaders);
    }

    [Fact]
    public async Task Birden_fazla_pinden_biri_eslesirse_kabul_edilir()
    {
        await _srv.StartAsync();
        var spool = NewSpool();
        spool.Enqueue(One(1));
        var pins = new[] { "sha256/" + Convert.ToBase64String(new byte[32]), SpkiPin.Compute(_srv.Cert) };
        Assert.Equal(UploadOutcome.Acked, await NewUploader(spool, pins).UploadOnceAsync(default));
    }

    [Fact]
    public async Task Ag_kesintisi_boyunca_sifir_kayip_ve_seq_sirasi_korunur_gercek_sunucu_yeniden_baslatma()
    {
        await _srv.StartAsync();
        var spool = NewSpool();
        var pins = new[] { SpkiPin.Compute(_srv.Cert) };
        var up = NewUploader(spool, pins);

        var first = spool.Enqueue(One(0));
        Assert.Equal(UploadOutcome.Acked, await up.UploadOnceAsync(default));

        await _srv.StopAsync(); // gercek kesinti: port kapali
        var queued = Enumerable.Range(1, 5).Select(i => spool.Enqueue(One(i))).ToList();
        for (var i = 0; i < 3; i++)
            Assert.Equal(UploadOutcome.Retry, await up.UploadOnceAsync(default)); // baglanti reddi = gecici
        Assert.Equal(5, spool.PendingCount); // kesintide hicbir sey kaybolmadi

        await _srv.StartAsync(); // sunucu ayni portta ve ayni sertifikayla geri geldi
        while (spool.PendingCount > 0)
            Assert.Equal(UploadOutcome.Acked, await up.UploadOnceAsync(default));

        var seqs = _srv.Bodies.Select(b => b.GetProperty("seq").GetInt64()).ToList();
        Assert.Equal(new[] { first.Seq }.Concat(queued.Select(q => q.Seq)), seqs); // bosluk yok, tekrar yok, sira korunur
    }
}
