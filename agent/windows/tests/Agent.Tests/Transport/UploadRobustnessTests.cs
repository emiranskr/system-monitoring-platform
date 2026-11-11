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
        _srv.Respond = _ => (307, "{}");
        // Yonlendirme basligi test sunucusunda yok; yine de 3xx'i hata sayip izlememeli.
        var outcome = await NewUploader(spool).UploadOnceAsync(default);

        Assert.Equal(UploadOutcome.Retry, outcome);
        Assert.Equal(1, spool.PendingCount);
        Assert.Empty(other.Bodies);
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
}

public class UploadRunnerTests
{
    private sealed class Script(params UploadOutcome[] outcomes)
    {
        private readonly Queue<UploadOutcome> _q = new(outcomes);
        public int Steps;
        public Task<UploadOutcome> Step(CancellationToken ct)
        {
            Steps++;
            return Task.FromResult(_q.Count > 0 ? _q.Dequeue() : UploadOutcome.AuthFailed);
        }
    }

    private static (UploadRunner Runner, List<TimeSpan> Delays) Make(Func<CancellationToken, Task<UploadOutcome>> step)
    {
        var delays = new List<TimeSpan>();
        var runner = new UploadRunner(step, (d, _) => { delays.Add(d); return Task.CompletedTask; }, new Random(7));
        return (runner, delays);
    }

    [Fact]
    public async Task Retry_art_arda_ustel_bekler_Acked_sayaci_sifirlar()
    {
        var s = new Script(UploadOutcome.Retry, UploadOutcome.Retry, UploadOutcome.Retry, UploadOutcome.Acked, UploadOutcome.Retry);
        var (r, delays) = Make(s.Step);

        var final = await r.RunAsync(CancellationToken.None);

        Assert.Equal(UploadOutcome.AuthFailed, final);   // betik bitince AuthFailed ile durur
        Assert.Equal(4, delays.Count);                   // 3 retry + 1 retry (Acked beklemez)
        Assert.True(delays[1] > delays[0] && delays[2] > delays[1]);          // artiyor
        Assert.InRange(delays[3].TotalSeconds, 0.5, 1.0);                     // Acked sonrasi sayac sifirlandi
    }

    [Fact]
    public async Task Idle_bir_saniye_bekler()
    {
        var (r, delays) = Make(new Script(UploadOutcome.Idle).Step);
        await r.RunAsync(CancellationToken.None);
        Assert.Equal(TimeSpan.FromSeconds(1), delays.Single());
    }

    [Fact]
    public async Task TlsRejected_tavan_kadar_bekler()
    {
        var (r, delays) = Make(new Script(UploadOutcome.TlsRejected).Step);
        await r.RunAsync(CancellationToken.None);
        Assert.Equal(Backoff.Cap, delays.Single());
    }

    [Fact]
    public async Task AuthFailed_dongunun_durmasini_saglar_ve_sonuc_doner()
    {
        var s = new Script(UploadOutcome.AuthFailed, UploadOutcome.Acked);
        var (r, _) = Make(s.Step);
        Assert.Equal(UploadOutcome.AuthFailed, await r.RunAsync(CancellationToken.None));
        Assert.Equal(1, s.Steps);
    }

    [Fact]
    public async Task Beklenmeyen_istisna_dongunun_dusmesine_yol_acmaz_Retry_gibi_beklenir_ve_bildirilir()
    {
        var calls = 0;
        var reported = new List<Exception>();
        var delays = new List<TimeSpan>();
        var r = new UploadRunner(_ =>
        {
            calls++;
            if (calls == 1) throw new InvalidOperationException("beklenmeyen");
            return Task.FromResult(UploadOutcome.AuthFailed);
        }, (d, _) => { delays.Add(d); return Task.CompletedTask; }, new Random(7), onUnexpected: reported.Add);

        var final = await r.RunAsync(CancellationToken.None);

        Assert.Equal(UploadOutcome.AuthFailed, final);
        Assert.Single(reported);
        Assert.Single(delays);
    }

    [Fact]
    public async Task Iptal_istisna_firlatmadan_null_ile_doner()
    {
        using var cts = new CancellationTokenSource();
        var r = new UploadRunner(async ct => { await cts.CancelAsync(); ct.ThrowIfCancellationRequested(); return UploadOutcome.Idle; },
            (_, _) => Task.CompletedTask, new Random(1));
        Assert.Null(await r.RunAsync(cts.Token));
    }
}
