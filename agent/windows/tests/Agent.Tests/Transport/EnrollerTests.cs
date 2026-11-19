using System.Net;
using System.Security.Authentication;
using System.Text;
using System.Text.Json;
using SysMon.Agent;
using SysMon.Agent.Transport;

namespace Agent.Tests.Transport;

public class EnrollerTests
{
    private static readonly Uri Server = new("https://monitor.example.com");
    private static readonly Guid EnrollId = Guid.Parse("11111111-1111-4111-8111-111111111111");
    private const string Token = "enroll-token-0123456789abcdef0123456789abcdef";
    private const string Credential = "credential-0123456789abcdef0123456789abcdef";

    private sealed class StubHandler(Func<HttpRequestMessage, string, HttpResponseMessage> respond) : HttpMessageHandler
    {
        public string? LastBody; public HttpRequestMessage? LastRequest;
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            LastRequest = request;
            LastBody = request.Content is null ? "" : await request.Content.ReadAsStringAsync(ct);
            return respond(request, LastBody);
        }
    }

    private static DeviceInfo Info() => DeviceInfoBuilder.Build("PC-01", "Microsoft Windows 11", "0.1.0",
        [new GpuInfo("gpu-abc", "NVIDIA RTX 4070")], [new NamedItem("Ethernet", "Ethernet")], [new NamedItem("C", "C:")]);

    private static HttpResponseMessage Json200(string json) => new(HttpStatusCode.OK) { Content = new StringContent(json, Encoding.UTF8, "application/json") };
    private static string GoodResponse(string cred = Credential) =>
        $$"""{"device_id":"22222222-2222-4222-8222-222222222222","credential":"{{cred}}","spki_pins":["sha256/AAAA"]}""";

    private static Task<EnrollResult> Run(StubHandler h, DeviceInfo? info = null, CancellationToken ct = default) =>
        Enroller.EnrollAsync(new HttpClient(h), Server, Token, EnrollId, "guid-1", info ?? Info(), ct);

    [Fact]
    public async Task Istek_sunucu_sozlesmesine_birebir_uyar_ve_POST_agent_v1_enroll_adresine_gider()
    {
        var h = new StubHandler((_, _) => Json200(GoodResponse()));
        var r = await Run(h);
        Assert.Equal(EnrollOutcome.Enrolled, r.Outcome);
        Assert.Equal(HttpMethod.Post, h.LastRequest!.Method);
        Assert.Equal("https://monitor.example.com/agent/v1/enroll", h.LastRequest.RequestUri!.ToString());
        Assert.Null(h.LastRequest.Headers.Authorization);                      // belirec govdede; Authorization basligi YOK

        using var doc = JsonDocument.Parse(h.LastBody!);
        var root = doc.RootElement;
        Assert.Equal(["device_info", "enroll_id", "machine_guid", "token"], root.EnumerateObject().Select(p => p.Name).Order().ToArray());   // strictObject: fazla/eksik alan yok
        Assert.Equal(Token, root.GetProperty("token").GetString());
        Assert.Equal(EnrollId.ToString(), root.GetProperty("enroll_id").GetString());
        Assert.Equal("guid-1", root.GetProperty("machine_guid").GetString());
        var di = root.GetProperty("device_info");
        Assert.Equal(["adapters", "agent_version", "gpus", "hostname", "os", "volumes"], di.EnumerateObject().Select(p => p.Name).Order().ToArray());
        var gpu = di.GetProperty("gpus")[0];
        Assert.Equal(["canonical_id", "name"], gpu.EnumerateObject().Select(p => p.Name).Order().ToArray());
        Assert.Equal("gpu-abc", gpu.GetProperty("canonical_id").GetString());
        Assert.Equal("NVIDIA RTX 4070", gpu.GetProperty("name").GetString());
        Assert.Equal(["id", "name"], di.GetProperty("adapters")[0].EnumerateObject().Select(p => p.Name).Order().ToArray());
        Assert.Equal("C", di.GetProperty("volumes")[0].GetProperty("id").GetString());
    }

    [Fact]
    public async Task Basarili_yanit_cihaz_kimligi_kimlik_bilgisi_ve_pinleri_dondurur()
    {
        var r = await Run(new StubHandler((_, _) => Json200(GoodResponse())));
        Assert.Equal(Guid.Parse("22222222-2222-4222-8222-222222222222"), r.DeviceId);
        Assert.Equal(Credential, r.Credential);
        Assert.Equal(["sha256/AAAA"], r.SpkiPins);
    }

    [Theory]
    [InlineData(401, EnrollOutcome.Rejected)]
    [InlineData(429, EnrollOutcome.RateLimited)]
    [InlineData(500, EnrollOutcome.ServerError)]
    [InlineData(503, EnrollOutcome.ServerError)]
    [InlineData(400, EnrollOutcome.ClientError)]
    [InlineData(404, EnrollOutcome.ClientError)]
    public async Task Durum_kodlari_dogru_sonuca_eslenir_ve_kimlik_bilgisi_uretilmez(int status, EnrollOutcome expected)
    {
        var r = await Run(new StubHandler((_, _) => new HttpResponseMessage((HttpStatusCode)status)));
        Assert.Equal(expected, r.Outcome);
        Assert.Null(r.Credential);
    }

    [Theory]
    [InlineData("{}")]
    [InlineData("not json")]
    [InlineData("""{"device_id":"degil-guid","credential":"credential-0123456789abcdef0123456789abcdef","spki_pins":[]}""")]
    [InlineData("""{"device_id":"22222222-2222-4222-8222-222222222222","credential":"kisa","spki_pins":[]}""")]
    [InlineData("""{"device_id":"22222222-2222-4222-8222-222222222222","credential":"credential-0123456789abcdef0123456789abcdef"}""")]
    public async Task Sozlesmeye_uymayan_200_yanit_KIMLIK_BILGISI_SAYILMAZ(string json)
    {
        var r = await Run(new StubHandler((_, _) => Json200(json)));
        Assert.Equal(EnrollOutcome.ServerError, r.Outcome);
        Assert.Null(r.Credential);
    }

    [Fact]
    public async Task TLS_dogrulama_hatasi_TlsRejected_ve_diger_ag_hatalari_NetworkError()
    {
        var tls = await Run(new StubHandler((_, _) => throw new HttpRequestException("x", new AuthenticationException("pin"))));
        Assert.Equal(EnrollOutcome.TlsRejected, tls.Outcome);
        var net = await Run(new StubHandler((_, _) => throw new HttpRequestException("baglanti reddedildi")));
        Assert.Equal(EnrollOutcome.NetworkError, net.Outcome);
        var timeout = await Run(new StubHandler((_, _) => throw new TaskCanceledException("zaman asimi")));
        Assert.Equal(EnrollOutcome.NetworkError, timeout.Outcome);
    }

    [Fact]
    public async Task Iptal_edilen_islem_istisnayi_yukari_tasir_NetworkError_saymaz()
    {
        using var cts = new CancellationTokenSource();
        cts.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => Run(new StubHandler((_, _) => throw new TaskCanceledException()), ct: cts.Token));
    }

    [Fact]
    public async Task Belirec_ve_kimlik_bilgisi_hata_ve_sonuc_metinlerine_SIZMAZ()
    {
        var r = await Run(new StubHandler((_, _) => throw new HttpRequestException("ag hatasi")));
        Assert.DoesNotContain(Token, r.ToString());
        var ok = await Run(new StubHandler((_, _) => Json200(GoodResponse())));
        Assert.DoesNotContain(Credential, ok.Outcome.ToString());
    }

    [Fact]
    public void DeviceInfoBuilder_sozlesme_sinirlarina_uyar()
    {
        var gpus = Enumerable.Range(0, 40).Select(i => new GpuInfo($"gpu-{i}", new string('G', 300))).Append(new GpuInfo("gpu-0", "kopya")).Append(new GpuInfo("  ", "bos-id"));
        var adapters = Enumerable.Range(0, 100).Select(i => new NamedItem($"nic{i}", i % 2 == 0 ? "" : new string('N', 200)));
        var info = DeviceInfoBuilder.Build(new string('h', 400), "", new string('v', 99), gpus, adapters, [new NamedItem("C", "C:"), new NamedItem("C", "kopya")]);
        Assert.Equal(255, info.Hostname.Length);
        Assert.Equal("Windows", info.Os);                              // bos OS -> yedek deger (sunucu min(1) ister)
        Assert.Equal(32, info.AgentVersion.Length);
        Assert.Equal(DeviceInfoBuilder.MaxGpus, info.Gpus.Count);
        Assert.All(info.Gpus, g => Assert.True(g.Name.Length <= 128 && g.CanonicalId.Length is > 0 and <= 64));
        Assert.Equal(info.Gpus.Count, info.Gpus.Select(g => g.CanonicalId).Distinct().Count());
        Assert.Equal(DeviceInfoBuilder.MaxAdapters, info.Adapters.Count);
        Assert.All(info.Adapters, a => Assert.InRange(a.Name.Length, 1, 128));   // bos ad kimlige dusurulur
        Assert.Single(info.Volumes);
    }

    [Fact]
    public void Enroll_secenegi_ayristirilir_server_gerektirir_ve_import_token_ile_birlikte_kullanilamaz()
    {
        var o = AgentOptions.Parse(["--enroll", "C:\\gecici\\kayit.txt", "--server", "https://monitor.example.com"]);
        Assert.Equal("C:\\gecici\\kayit.txt", o.EnrollTokenFile);
        Assert.Throws<ArgumentException>(() => AgentOptions.Parse(["--enroll", "kayit.txt"]));
        Assert.Throws<ArgumentException>(() => AgentOptions.Parse(["--enroll", "kayit.txt", "--import-token", "t.txt", "--server", "https://x.example.com"]));
        Assert.Throws<ArgumentException>(() => AgentOptions.Parse(["--enroll"]));
        Assert.Null(AgentOptions.Parse([]).EnrollTokenFile);
    }
}

public class RotatorTests
{
    private static readonly Uri Server = new("https://monitor.example.com");
    private static readonly Guid RotationId = Guid.Parse("33333333-3333-4333-8333-333333333333");
    private const string Current = "current-0123456789abcdef0123456789abcdef";
    private const string NewCred = "newcred-0123456789abcdef0123456789abcdef";

    private sealed class Stub(Func<HttpRequestMessage, string, HttpResponseMessage> respond) : HttpMessageHandler
    {
        public HttpRequestMessage? Last; public string? Body;
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage r, CancellationToken ct)
        { Last = r; Body = r.Content is null ? "" : await r.Content.ReadAsStringAsync(ct); return respond(r, Body); }
    }
    private static HttpResponseMessage Ok(string json) => new(HttpStatusCode.OK) { Content = new StringContent(json, Encoding.UTF8, "application/json") };
    private static Task<RotateResult> Run(Stub s) => Rotator.RotateAsync(new HttpClient(s), Server, Current, RotationId);

    [Fact]
    public async Task Istek_mevcut_kimlik_bilgisini_Bearer_ve_yalniz_rotation_id_govdesiyle_gonderir()
    {
        var s = new Stub((_, _) => Ok($$"""{"credential":"{{NewCred}}","overlap_expires_at":"2026-11-20T10:00:00.000Z"}"""));
        var r = await Run(s);
        Assert.Equal(RotateOutcome.Rotated, r.Outcome);
        Assert.Equal(NewCred, r.Credential);
        Assert.Equal(new DateTimeOffset(2026, 11, 20, 10, 0, 0, TimeSpan.Zero), r.OverlapExpiresAt);
        Assert.Equal("https://monitor.example.com/agent/v1/rotate", s.Last!.RequestUri!.ToString());
        Assert.Equal("Bearer", s.Last.Headers.Authorization!.Scheme);
        Assert.Equal(Current, s.Last.Headers.Authorization.Parameter);
        using var doc = JsonDocument.Parse(s.Body!);
        Assert.Equal(["rotation_id"], doc.RootElement.EnumerateObject().Select(p => p.Name).ToArray());   // strictObject
        Assert.Equal(RotationId.ToString(), doc.RootElement.GetProperty("rotation_id").GetString());
    }

    [Theory]
    [InlineData(401, RotateOutcome.Rejected)]
    [InlineData(403, RotateOutcome.Rejected)]
    [InlineData(409, RotateOutcome.Conflict)]
    [InlineData(429, RotateOutcome.RateLimited)]
    [InlineData(500, RotateOutcome.ServerError)]
    [InlineData(400, RotateOutcome.ClientError)]
    public async Task Durum_kodlari_eslenir_ve_yeni_kimlik_bilgisi_uretilmez(int status, RotateOutcome expected)
    {
        var r = await Run(new Stub((_, _) => new HttpResponseMessage((HttpStatusCode)status)));
        Assert.Equal(expected, r.Outcome);
        Assert.Null(r.Credential);
    }

    [Theory]
    [InlineData("{}")]
    [InlineData("""{"credential":"kisa","overlap_expires_at":"2026-11-20T10:00:00Z"}""")]
    [InlineData("""{"credential":"newcred-0123456789abcdef0123456789abcdef","overlap_expires_at":"tarih-degil"}""")]
    public async Task Sozlesmeye_uymayan_yanit_yeni_kimlik_bilgisi_SAYILMAZ(string json)
    {
        var r = await Run(new Stub((_, _) => Ok(json)));
        Assert.Equal(RotateOutcome.ServerError, r.Outcome);
        Assert.Null(r.Credential);
    }

    [Fact]
    public async Task TLS_hatasi_ve_ag_hatasi_ayirt_edilir()
    {
        Assert.Equal(RotateOutcome.TlsRejected, (await Run(new Stub((_, _) => throw new HttpRequestException("x", new AuthenticationException("pin"))))).Outcome);
        Assert.Equal(RotateOutcome.NetworkError, (await Run(new Stub((_, _) => throw new HttpRequestException("ag")))).Outcome);
    }

    [Fact]
    public void Rotate_secenegi_server_gerektirir_ve_enroll_ile_birlikte_kullanilamaz()
    {
        Assert.True(AgentOptions.Parse(["--rotate", "--server", "https://x.example.com"]).Rotate);
        Assert.False(AgentOptions.Parse([]).Rotate);
        Assert.Throws<ArgumentException>(() => AgentOptions.Parse(["--rotate"]));
        Assert.Throws<ArgumentException>(() => AgentOptions.Parse(["--rotate", "--enroll", "k.txt", "--server", "https://x.example.com"]));
    }
}
