using SysMon.Agent;
using SysMon.Agent.Transport;

namespace Agent.Tests.Transport;

/// <summary>
/// Bozuk/beklenmeyen sunucu yanitlari (proxy HTML sayfasi, eksik alan, yanlis tip) yukleme dongusunu
/// ve dolayisiyla servisi dusurmemeli; batch korunmali ve yeniden denenmeli.
/// </summary>
public sealed class UploadRobustnessTests : IAsyncDisposable
{
    private readonly string _dir = Path.Combine(Path.GetTempPath(), "sysmon-rob-" + Guid.NewGuid().ToString("N"));
    private readonly TestHttpsServer _srv = new();
    private DateTimeOffset _now = new(2026, 11, 11, 9, 0, 0, TimeSpan.Zero);

    public async ValueTask DisposeAsync()
    {
        await _srv.DisposeAsync();
        if (Directory.Exists(_dir)) Directory.Delete(_dir, true);
    }

    private static IReadOnlyList<Sample> One(double v) =>
        [new Sample(new DateTimeOffset(2026, 11, 11, 9, 0, 0, TimeSpan.Zero), new Dictionary<string, double?> { ["cpu.total"] = v })];

    private Spool NewSpool() => new(_dir, new SpoolLimits(50_000_000, TimeSpan.FromHours(24), 1_000_000), () => _now);

    private Uploader NewUploader(Spool s) =>
        new(s, HttpClients.Create([SpkiPin.Compute(_srv.Cert)]), _srv.Url, () => "t", AgentOptions.Parse([]), () => _now);

    [Theory]
    [InlineData("<html><body>502 Bad Gateway</body></html>")]
    [InlineData("")]
    [InlineData("{}")]
    [InlineData("{\"ack_seq\":\"yedi\"}")]
    [InlineData("{\"ack_seq\":null}")]
    [InlineData("[1,2,3]")]
    [InlineData("{\"ack_seq\":99999999999999999999999999}")]
    public async Task Bozuk_200_yaniti_Retry_doner_batch_korunur_istisna_firlatmaz(string body)
    {
        await _srv.StartAsync();
        var spool = NewSpool();
        spool.Enqueue(One(1));
        _srv.Respond = _ => (200, body);

        Assert.Equal(UploadOutcome.Retry, await NewUploader(spool).UploadOnceAsync(default));
        Assert.Equal(1, spool.PendingCount);
    }

    [Fact]
    public async Task O7_Yonlendirme_takip_edilmez_ikinci_hosta_istek_ve_veri_gitmez()
    {
        await using var other = new TestHttpsServer();
        await other.StartAsync();
        await _srv.StartAsync();
        var spool = NewSpool();
        spool.Enqueue(One(1));
        // GERCEK yonlendirme: Location ikinci sunucuyu gosterir ve istemci HER IKI sertifikayi da pinler; yani yonlendirme
        // takip EDILSEYDI istek ikinci sunucuya ulasir ve basarili olurdu (AllowAutoRedirect=true mutasyonunda bu test kirilir).
        _srv.Respond = _ => (307, "{}");
        _srv.RedirectLocation = new Uri(other.Url, "agent/v1/ingest").ToString();
        var up = new Uploader(spool, HttpClients.Create([SpkiPin.Compute(_srv.Cert), SpkiPin.Compute(other.Cert)]), _srv.Url,
            () => "t", AgentOptions.Parse([]), () => _now);

        var outcome = await up.UploadOnceAsync(default);

        Assert.Equal(UploadOutcome.Retry, outcome);
        Assert.Equal(1, spool.PendingCount);
        Assert.Empty(other.Bodies);        // ikinci hosta veri gitmedi
        Assert.Empty(other.AuthHeaders);   // ve token da gitmedi
    }

    [Fact]
    public async Task Ack_seq_gonderilen_seqten_kucukse_batch_silinmez_Release_dahil()
    {
        await _srv.StartAsync();
        var spool = NewSpool();
        spool.Enqueue(One(1)); // seq 0
        _srv.Respond = _ => (200, "{\"ack_seq\":-1,\"rejected\":0}");

        Assert.Equal(UploadOutcome.Retry, await NewUploader(spool).UploadOnceAsync(default));
        Assert.Equal(1, spool.PendingCount);
    }

    [Fact]
    public async Task O7_Cok_buyuk_yanit_govdesi_bellegi_doldurmaz_Retry_doner()
    {
        await _srv.StartAsync();
        var spool = NewSpool();
        spool.Enqueue(One(1));
        _srv.Respond = _ => (200, "{\"ack_seq\":0,\"pad\":\"" + new string('x', 5_000_000) + "\"}");

        var outcome = await NewUploader(spool).UploadOnceAsync(default);

        Assert.Equal(UploadOutcome.Retry, outcome); // 1 MB tampon sinirini asti -> hata; veri onaylanmis sayilmaz
        Assert.Equal(1, spool.PendingCount);
    }

    [Fact]
    public async Task K2_Asiri_server_time_ofseti_yok_sayilir_yukleme_hatti_kilitlenmez()
    {
        await _srv.StartAsync();
        var spool = NewSpool();
        spool.Enqueue(One(1));
        _srv.Respond = b => (200, $"{{\"ack_seq\":{b.GetProperty("seq").GetInt64()},\"rejected\":0,\"server_time\":\"9999-12-31T00:00:00Z\"}}");
        var up = NewUploader(spool);

        Assert.Equal(UploadOutcome.Acked, await up.UploadOnceAsync(default));
        Assert.Equal(TimeSpan.Zero, spool.ClockOffset); // makul sinirin disinda: uygulanmadi

        spool.Enqueue(One(2)); // sonraki yukleme ArgumentOutOfRange ile cokmemeli
        Assert.Equal(UploadOutcome.Acked, await up.UploadOnceAsync(default));
    }

    [Fact]
    public async Task K2_409_ile_gelen_asiri_server_time_yok_sayilir()
    {
        await _srv.StartAsync();
        var spool = NewSpool();
        spool.Enqueue(One(1));
        _srv.Respond = _ => (409, "{\"error\":\"clock_skew\",\"server_time\":\"9999-12-31T00:00:00Z\"}");
        Assert.Equal(UploadOutcome.Retry, await NewUploader(spool).UploadOnceAsync(default));
        Assert.Equal(TimeSpan.Zero, spool.ClockOffset);
    }

    [Fact]
    public async Task K2_Makul_ofset_uygulanir_366_gun_siniri_icinde()
    {
        await _srv.StartAsync();
        var spool = NewSpool();
        spool.Enqueue(One(1));
        _srv.Respond = _ => (409, "{\"error\":\"clock_skew\",\"server_time\":\"2026-11-11T09:10:00Z\"}");
        Assert.Equal(UploadOutcome.Retry, await NewUploader(spool).UploadOnceAsync(default));
        Assert.Equal(TimeSpan.FromMinutes(10), spool.ClockOffset);
    }

    [Theory]
    [InlineData("12345")]
    [InlineData("true")]
    [InlineData("null")]
    [InlineData("\"bu bir tarih degil\"")]
    public async Task K2_server_time_beklenmeyen_tipte_olsa_da_istisna_firlatmaz(string rawServerTime)
    {
        await _srv.StartAsync();
        var spool = NewSpool();
        var b = spool.Enqueue(One(1));
        _srv.Respond = _ => (200, $"{{\"ack_seq\":{b.Seq},\"rejected\":0,\"server_time\":{rawServerTime}}}");
        Assert.Equal(UploadOutcome.Acked, await NewUploader(spool).UploadOnceAsync(default));
        Assert.Equal(TimeSpan.Zero, spool.ClockOffset);

        spool.Enqueue(One(2));
        _srv.Respond = _ => (409, $"{{\"server_time\":{rawServerTime}}}");
        Assert.Equal(UploadOutcome.Retry, await NewUploader(spool).UploadOnceAsync(default));
    }

    [Theory]
    [InlineData("[\"conflict\"]")]
    [InlineData("\"conflict\"")]
    [InlineData("123")]
    [InlineData("true")]
    public async Task K2_409_yaniti_JSON_nesnesi_olmasa_bile_istisna_firlatmaz_Retry_doner(string rawJson)
    {
        await _srv.StartAsync();
        var spool = NewSpool();
        spool.Enqueue(One(1));
        _srv.Respond = _ => (409, rawJson);
        Assert.Equal(UploadOutcome.Retry, await NewUploader(spool).UploadOnceAsync(default));
        Assert.Equal(TimeSpan.Zero, spool.ClockOffset);
    }

    [Fact]
    public async Task K2_Saat_dilimi_eki_olmayan_server_time_UTC_sayilir_Turkce_yerel_ayarda_bile()
    {
        var old = System.Globalization.CultureInfo.CurrentCulture;
        System.Globalization.CultureInfo.CurrentCulture = new System.Globalization.CultureInfo("tr-TR");
        try
        {
            await _srv.StartAsync();
            var spool = NewSpool();
            spool.Enqueue(One(1));
            _srv.Respond = _ => (409, "{\"server_time\":\"2026-11-11T09:10:00\"}"); // 'Z' yok
            Assert.Equal(UploadOutcome.Retry, await NewUploader(spool).UploadOnceAsync(default));
            Assert.Equal(TimeSpan.FromMinutes(10), spool.ClockOffset); // yerel saat dilimi (UTC+3) kaymasi olmamali
        }
        finally { System.Globalization.CultureInfo.CurrentCulture = old; }
    }

    [Fact]
    public async Task O11_Yerel_ayar_ar_SA_ve_th_TH_olsa_bile_zaman_damgalari_Gregoryen_ASCII_ISO_formatinda()
    {
        var old = System.Globalization.CultureInfo.CurrentCulture;
        try
        {
            foreach (var cn in new[] { "ar-SA", "th-TH", "fa-IR" })
            {
                System.Globalization.CultureInfo.CurrentCulture = new System.Globalization.CultureInfo(cn);
                await _srv.StartAsync();
                var spool = new Spool(Path.Combine(_dir, cn), new SpoolLimits(50_000_000, TimeSpan.FromHours(24), 1_000_000), () => _now);
                spool.Enqueue(One(1));
                await NewUploader(spool).UploadOnceAsync(default);
                var body = _srv.Bodies.Last();
                Assert.Matches(@"^2026-11-11T09:00:00Z$", body.GetProperty("samples")[0].GetProperty("ts").GetString());
                Assert.Matches(@"^2026-11-11T09:00:00Z$", body.GetProperty("sent_at").GetString());
                await _srv.StopAsync();
            }
        }
        finally { System.Globalization.CultureInfo.CurrentCulture = old; }
    }

    [Fact]
    public async Task O8_Ayni_batch_icin_ardisik_10_kalici_4xx_batchi_atar_sonraki_batch_gonderilir()
    {
        await _srv.StartAsync();
        var spool = NewSpool();
        var poison = spool.Enqueue(One(1));
        var next = spool.Enqueue(One(2));
        _srv.Respond = body => body.GetProperty("seq").GetInt64() == poison.Seq
            ? (413, "{\"error\":\"too large\"}")
            : (200, $"{{\"ack_seq\":{next.Seq},\"rejected\":0}}");
        var up = NewUploader(spool);
        var dropped = new List<long>();
        up.BatchDropped += (b, status) => dropped.Add(b.Seq);

        for (var i = 0; i < 9; i++) Assert.Equal(UploadOutcome.Retry, await up.UploadOnceAsync(default));
        Assert.Empty(dropped);
        Assert.Equal(2, spool.PendingCount);

        Assert.Equal(UploadOutcome.Acked, await up.UploadOnceAsync(default)); // 10. deneme: atilir
        Assert.Equal(new[] { poison.Seq }, dropped);
        Assert.Equal(next.Seq, spool.PeekOldest()!.Seq);
        Assert.Equal(UploadOutcome.Acked, await up.UploadOnceAsync(default));
        Assert.Equal(0, spool.PendingCount);
    }

    [Fact]
    public async Task O8_Gecici_hatalar_503_429_batchi_asla_atmaz()
    {
        await _srv.StartAsync();
        var spool = NewSpool();
        spool.Enqueue(One(1));
        var up = NewUploader(spool);
        var dropped = 0;
        up.BatchDropped += (_, _) => dropped++;
        foreach (var status in new[] { 503, 429, 502, 504, 500 })
        {
            _srv.Respond = _ => (status, "{}");
            for (var i = 0; i < 12; i++) Assert.Equal(UploadOutcome.Retry, await up.UploadOnceAsync(default));
        }
        Assert.Equal(0, dropped);
        Assert.Equal(1, spool.PendingCount);
    }

    [Fact]
    public async Task O8_Basarili_yukleme_kalici_hata_sayacini_sifirlar()
    {
        await _srv.StartAsync();
        var spool = NewSpool();
        var a = spool.Enqueue(One(1));
        var up = NewUploader(spool);
        var dropped = 0;
        up.BatchDropped += (_, _) => dropped++;

        _srv.Respond = _ => (400, "{}");
        for (var i = 0; i < 9; i++) await up.UploadOnceAsync(default);
        _srv.Respond = _ => (200, $"{{\"ack_seq\":{a.Seq},\"rejected\":0}}");
        Assert.Equal(UploadOutcome.Acked, await up.UploadOnceAsync(default));

        var b = spool.Enqueue(One(2));
        _srv.Respond = _ => (400, "{}");
        for (var i = 0; i < 9; i++) Assert.Equal(UploadOutcome.Retry, await up.UploadOnceAsync(default)); // yeni batch icin sayac 0'dan
        Assert.Equal(0, dropped);
        Assert.Equal(b.Seq, spool.PeekOldest()!.Seq);
    }
}

public class UploadRunnerTests
{
    private sealed class Script(params UploadOutcome[] outcomes)
    {
        private readonly Queue<UploadOutcome> _q = new(outcomes);
        public int Steps;
        public bool Exhausted => _q.Count == 0;
        public Task<UploadOutcome> Step(CancellationToken ct)
        {
            Steps++;
            return Task.FromResult(_q.Count > 0 ? _q.Dequeue() : UploadOutcome.Idle);
        }
    }

    /// <summary>Betik bitince (kuyruk bosalinca) dongu iptal edilir; bekleme sureleri kaydedilir (gercek beklemeden).</summary>
    private static async Task<List<TimeSpan>> Run(Script s, Func<CancellationToken, Task<UploadOutcome>>? step = null)
    {
        var delays = new List<TimeSpan>();
        using var cts = new CancellationTokenSource();
        var runner = new UploadRunner(step ?? s.Step, (d, _) =>
        {
            delays.Add(d);
            if (s.Exhausted) cts.Cancel();
            return Task.CompletedTask;
        }, new Random(7));
        await runner.RunAsync(cts.Token);
        return delays;
    }

    [Fact]
    public async Task Retry_art_arda_ustel_bekler_Acked_sayaci_sifirlar()
    {
        var delays = await Run(new Script(UploadOutcome.Retry, UploadOutcome.Retry, UploadOutcome.Retry, UploadOutcome.Acked, UploadOutcome.Retry));
        Assert.Equal(4, delays.Count);
        Assert.True(delays[1] > delays[0] && delays[2] > delays[1]);
        Assert.InRange(delays[3].TotalSeconds, 0.5, 1.0); // Acked sonrasi sayac sifirlandi
    }

    [Fact]
    public async Task Idle_bir_saniye_bekler()
    {
        var delays = await Run(new Script(UploadOutcome.Idle));
        Assert.Equal(TimeSpan.FromSeconds(1), delays[0]);
    }

    [Fact]
    public async Task TlsRejected_tavan_kadar_bekler()
    {
        var delays = await Run(new Script(UploadOutcome.TlsRejected));
        Assert.Equal(Backoff.Cap, delays[0]);
    }

    [Fact]
    public async Task Inceleme_AuthFailed_kalici_durmaz_5_dakika_bekleyip_yeniden_dener_token_degisince_toparlanir()
    {
        var s = new Script(UploadOutcome.AuthFailed, UploadOutcome.AuthFailed, UploadOutcome.Acked, UploadOutcome.Idle);
        var delays = await Run(s);
        Assert.Equal(Backoff.Cap, delays[0]);
        Assert.Equal(Backoff.Cap, delays[1]);
        Assert.True(s.Steps >= 4, "AuthFailed sonrasi dongu devam etmeli ve sonraki Acked'e ulasmali");
    }

    [Fact]
    public async Task Beklenmeyen_istisna_dongunun_dusmesine_yol_acmaz_Retry_gibi_beklenir_ve_bildirilir()
    {
        var calls = 0;
        var reported = new List<Exception>();
        var delays = new List<TimeSpan>();
        using var cts = new CancellationTokenSource();
        var r = new UploadRunner(_ =>
        {
            calls++;
            if (calls == 1) throw new InvalidOperationException("beklenmeyen");
            return Task.FromResult(UploadOutcome.Idle);
        }, (d, _) => { delays.Add(d); if (delays.Count == 2) cts.Cancel(); return Task.CompletedTask; }, new Random(7), onUnexpected: reported.Add);

        await r.RunAsync(cts.Token);

        Assert.Single(reported);
        Assert.True(delays.Count >= 2);
    }

    [Fact]
    public async Task Iptal_istisna_firlatmadan_doner()
    {
        using var cts = new CancellationTokenSource();
        var r = new UploadRunner(async ct => { await cts.CancelAsync(); ct.ThrowIfCancellationRequested(); return UploadOutcome.Idle; },
            (_, _) => Task.CompletedTask, new Random(1));
        await r.RunAsync(cts.Token); // istisna firlatmamali
    }
}
