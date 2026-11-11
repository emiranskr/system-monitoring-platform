#if DEBUG
using System.IO.Compression;
using System.Net;
using System.Text;
using System.Text.Json;
using SysMon.Agent;
using SysMon.Agent.Transport;

namespace Agent.Tests.Transport;

/// <summary>Gercek HTTP sunucusu (HttpListener, loopback). Debug derlemesinde calisir; Release http'yi yasaklar.</summary>
public sealed class UploaderTests : IDisposable
{
    private sealed class TestServer : IDisposable
    {
        private readonly HttpListener _l = new();
        public Uri Url { get; }
        public List<(string? Auth, string? Encoding, JsonElement Body)> Requests { get; } = [];
        public Func<int, (int Status, string Json)> Respond { get; set; } = _ => (200, "{}");
        private readonly Task _loop;

        public TestServer()
        {
            var probe = new System.Net.Sockets.TcpListener(IPAddress.Loopback, 0);
            probe.Start();
            var port = ((IPEndPoint)probe.LocalEndpoint).Port;
            probe.Stop();
            Url = new Uri($"http://127.0.0.1:{port}/");
            _l.Prefixes.Add(Url.ToString());
            _l.Start();
            _loop = Task.Run(async () =>
            {
                while (_l.IsListening)
                {
                    HttpListenerContext ctx;
                    try { ctx = await _l.GetContextAsync(); } catch { return; }
                    using var ms = new MemoryStream();
                    Stream input = ctx.Request.InputStream;
                    if (ctx.Request.Headers["Content-Encoding"] == "gzip") input = new GZipStream(input, CompressionMode.Decompress);
                    await input.CopyToAsync(ms);
                    var body = JsonDocument.Parse(ms.ToArray()).RootElement.Clone();
                    Requests.Add((ctx.Request.Headers["Authorization"], ctx.Request.Headers["Content-Encoding"], body));
                    var (status, json) = Respond(Requests.Count);
                    var bytes = Encoding.UTF8.GetBytes(json);
                    ctx.Response.StatusCode = status;
                    ctx.Response.ContentType = "application/json";
                    await ctx.Response.OutputStream.WriteAsync(bytes);
                    ctx.Response.Close();
                }
            });
        }

        public void Dispose()
        {
            _l.Stop();
            _l.Close();
        }
    }

    private readonly string _dir = Path.Combine(Path.GetTempPath(), "sysmon-up-" + Guid.NewGuid().ToString("N"));
    private readonly TestServer _srv = new();
    private DateTimeOffset _now = new(2026, 11, 11, 9, 0, 0, TimeSpan.Zero);

    public void Dispose()
    {
        _srv.Dispose();
        if (Directory.Exists(_dir)) Directory.Delete(_dir, true);
    }

    private Spool NewSpool() =>
        new(_dir, new SpoolLimits(50_000_000, TimeSpan.FromHours(24), 1_000_000), () => _now);

    private Uploader NewUploader(Spool s) =>
        new(s, new HttpClient { Timeout = TimeSpan.FromSeconds(5) }, _srv.Url, () => "tok-123",
            AgentOptions.Parse(["--allow-insecure-loopback"]), () => _now);

    private static IReadOnlyList<Sample> One(double v) =>
        [new Sample(new DateTimeOffset(2026, 11, 11, 9, 0, 0, TimeSpan.Zero), new Dictionary<string, double?> { ["cpu.total"] = v })];

    private static string Ack(long seq, int rejected = 0) =>
        JsonSerializer.Serialize(new { ack_seq = seq, rejected, server_time = "2026-11-11T09:00:00Z" });

    [Fact]
    public async Task Basarili_yukleme_batchi_siler_ve_gzip_bearer_ile_gider()
    {
        var spool = NewSpool();
        var b = spool.Enqueue(One(7));
        _srv.Respond = _ => (200, Ack(b.Seq));

        var outcome = await NewUploader(spool).UploadOnceAsync(default);

        Assert.Equal(UploadOutcome.Acked, outcome);
        Assert.Null(spool.PeekOldest());
        var (auth, enc, body) = _srv.Requests.Single();
        Assert.Equal("Bearer tok-123", auth);
        Assert.Equal("gzip", enc);
        Assert.Equal(1, body.GetProperty("v").GetInt32());
        Assert.Equal(b.Seq, body.GetProperty("seq").GetInt64());
        Assert.Equal(b.Epoch.ToString(), body.GetProperty("spool_epoch").GetString());
        Assert.False(body.TryGetProperty("device_id", out _)); // kimlik govdede tasinmaz
    }

    [Fact]
    public async Task Kesinti_sirasinda_sifir_kayip_ve_seq_sirasiyla_teslim()
    {
        var spool = NewSpool();
        var batches = Enumerable.Range(0, 3).Select(i => spool.Enqueue(One(i))).ToList();
        var up = NewUploader(spool);

        _srv.Respond = _ => (503, "{}");
        for (var i = 0; i < 4; i++) Assert.Equal(UploadOutcome.Retry, await up.UploadOnceAsync(default));
        Assert.Equal(3, spool.PendingCount); // hicbir sey kaybolmadi

        var delivered = new List<long>();
        _srv.Respond = n => { var seq = _srv.Requests[n - 1].Body.GetProperty("seq").GetInt64(); delivered.Add(seq); return (200, Ack(seq)); };
        while (spool.PendingCount > 0) Assert.Equal(UploadOutcome.Acked, await up.UploadOnceAsync(default));

        Assert.Equal(batches.Select(b => b.Seq), delivered);
    }

    [Fact]
    public async Task Ack_seq_kucukse_batch_silinmez_ve_yeniden_gonderilir()
    {
        var spool = NewSpool();
        var b = spool.Enqueue(One(1));
        _srv.Respond = _ => (200, Ack(b.Seq - 1));
        Assert.Equal(UploadOutcome.Retry, await NewUploader(spool).UploadOnceAsync(default));
        Assert.Equal(1, spool.PendingCount);
    }

    [Fact]
    public async Task Kalici_ret_ack_ilerlettirir_zehirli_batch_kuyrugu_tikamaz()
    {
        var spool = NewSpool();
        var poison = spool.Enqueue(One(1));
        var next = spool.Enqueue(One(2));
        _srv.Respond = n => n == 1 ? (200, Ack(poison.Seq, rejected: 1)) : (200, Ack(next.Seq));
        var up = NewUploader(spool);

        Assert.Equal(UploadOutcome.Acked, await up.UploadOnceAsync(default));
        Assert.Equal(next.Seq, spool.PeekOldest()!.Seq);
        Assert.Equal(1, up.RejectedSamples);
    }

    [Theory]
    [InlineData(401)]
    [InlineData(403)]
    public async Task Yetki_hatasinda_durur_ve_spool_korunur(int status)
    {
        var spool = NewSpool();
        spool.Enqueue(One(1));
        _srv.Respond = _ => (status, "{}");
        Assert.Equal(UploadOutcome.AuthFailed, await NewUploader(spool).UploadOnceAsync(default));
        Assert.Equal(1, spool.PendingCount);
    }

    [Fact]
    public async Task Saat_sapmasi_409_server_time_ile_ofset_ogrenir_ve_yeniden_dener()
    {
        var spool = NewSpool();
        spool.Enqueue(One(1));
        _srv.Respond = _ => (409, "{\"error\":\"clock_skew\",\"server_time\":\"2026-11-11T09:10:00Z\"}");
        Assert.Equal(UploadOutcome.Retry, await NewUploader(spool).UploadOnceAsync(default));
        Assert.Equal(TimeSpan.FromMinutes(10), spool.ClockOffset);
    }

    [Fact]
    public async Task Bos_spool_Idle_doner_ve_istek_atmaz()
    {
        Assert.Equal(UploadOutcome.Idle, await NewUploader(NewSpool()).UploadOnceAsync(default));
        Assert.Empty(_srv.Requests);
    }

    [Fact]
    public void Loopback_disi_http_sunucu_reddedilir()
    {
        Assert.Throws<ArgumentException>(() => new Uploader(NewSpool(), new HttpClient(), new Uri("http://example.com/"),
            () => "t", AgentOptions.Parse(["--allow-insecure-loopback"]), () => _now));
    }

    [Fact]
    public void Backoff_ustel_artar_5_dakikada_tavanlanir_ve_jitter_uygular()
    {
        var max = Backoff.Next(30, new Random(1));
        Assert.InRange(max.TotalSeconds, 150, 300);
        var a0 = Backoff.Next(0, new Random(1));
        var a3 = Backoff.Next(3, new Random(1));
        Assert.True(a3 > a0);
        Assert.InRange(a0.TotalSeconds, 0.5, 1.0);
    }
}
#endif
