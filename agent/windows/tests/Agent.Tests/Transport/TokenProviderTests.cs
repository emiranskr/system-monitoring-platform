using SysMon.Agent;
using SysMon.Agent.Transport;

namespace Agent.Tests.Transport;

/// <summary>I-4: token okuma durumu degisiminde bir kez loglanir (deger ASLA loglanmaz); bos token istek gondermez.</summary>
public sealed class TokenProviderTests : IAsyncDisposable
{
    private const string Secret = "tok_cok_gizli_deger_123";
    private bool _exists;
    private (bool Ok, string? Token) _load = (false, null);
    private readonly List<string> _info = [];
    private readonly List<string> _warn = [];

    private TokenProvider Make() => new(@"C:\veri\identity\token.bin", () => (_load.Ok, _load.Token), () => _exists, _info.Add, _warn.Add);

    [Fact]
    public void Dosya_yoksa_bos_doner_ve_durum_degisiminde_yalniz_bir_kez_uyarir()
    {
        var p = Make();
        Assert.Equal("", p.Get());
        Assert.Equal("", p.Get());
        Assert.Equal("", p.Get());

        var w = Assert.Single(_warn);
        Assert.Contains("token.bin", w);
        Assert.Contains("yok", w);
        Assert.Empty(_info);
    }

    [Fact]
    public void Dosya_var_ama_okunamiyorsa_okunamadi_nedeniyle_bir_kez_uyarir()
    {
        _exists = true;
        var p = Make();
        p.Get();
        p.Get();

        var w = Assert.Single(_warn);
        Assert.Contains("okunamadi", w);
        Assert.Contains("token.bin", w);
    }

    [Fact]
    public void Token_sonradan_erisilebilir_olursa_yeniden_yuklenir_ve_Token_yuklendi_bir_kez_yazilir()
    {
        var p = Make();
        Assert.Equal("", p.Get());

        _exists = true;
        _load = (true, Secret);
        Assert.Equal(Secret, p.Get());
        Assert.Equal(Secret, p.Get());

        var i = Assert.Single(_info);
        Assert.Contains("Token yuklendi", i);
    }

    [Fact]
    public void Token_degeri_hicbir_log_satirina_yazilmaz()
    {
        var p = Make();
        p.Get();
        _exists = true;
        _load = (true, Secret);
        p.Get();
        _load = (false, null); // sonradan okunamaz
        p.Get();

        Assert.DoesNotContain(_info.Concat(_warn), l => l.Contains(Secret));
        Assert.Equal(2, _warn.Count); // yok + okunamadi
    }

    [Fact]
    public void Yuklu_iken_bir_kez_basarisiz_olursa_eski_degeri_sunmaz_bos_doner()
    {
        _exists = true;
        _load = (true, Secret);
        var p = Make();
        Assert.Equal(Secret, p.Get());

        _load = (false, null);
        Assert.Equal("", p.Get()); // eski token bellekte tutulup kullanilmaz
    }

    public ValueTask DisposeAsync() => ValueTask.CompletedTask;
}

/// <summary>Bos token ile sunucuya HICBIR istek gitmez; token gelince yukleme devam eder.</summary>
public sealed class UploaderEmptyTokenTests : IAsyncDisposable
{
    private readonly string _dir = Path.Combine(Path.GetTempPath(), "sysmon-tok-" + Guid.NewGuid().ToString("N"));
    private readonly TestHttpsServer _srv = new();
    private readonly DateTimeOffset _now = new(2026, 11, 12, 9, 0, 0, TimeSpan.Zero);

    public async ValueTask DisposeAsync()
    {
        await _srv.DisposeAsync();
        if (Directory.Exists(_dir)) Directory.Delete(_dir, true);
    }

    [Fact]
    public async Task Bos_token_istek_gondermez_AuthFailed_doner_sonra_token_gelince_gonderir()
    {
        await _srv.StartAsync();
        var spool = new Spool(_dir, new SpoolLimits(50_000_000, TimeSpan.FromHours(24), 1_000_000), () => _now);
        var batch = spool.Enqueue([new Sample(_now, new Dictionary<string, double?> { ["cpu.total"] = 1 })]);
        _srv.Respond = body => (200, $"{{\"ack_seq\":{batch.Seq}}}");
        var token = "";
        var up = new Uploader(spool, HttpClients.Create([SpkiPin.Compute(_srv.Cert)]), _srv.Url, () => token,
            AgentOptions.Parse([]), () => _now);

        Assert.Equal(UploadOutcome.AuthFailed, await up.UploadOnceAsync(default));
        Assert.Empty(_srv.AuthHeaders); // sunucuya hicbir istek (bos Bearer dahil) gitmedi
        Assert.Equal(1, spool.PendingCount);

        token = "tok_gecerli";
        Assert.Equal(UploadOutcome.Acked, await up.UploadOnceAsync(default));
        Assert.Equal("Bearer tok_gecerli", Assert.Single(_srv.AuthHeaders));
        Assert.Equal(0, spool.PendingCount);
    }
}
