using System.IO.Pipes;
using System.Security.Principal;
using SysMon.Agent.Sensors;

namespace Agent.Tests.Sensors;

public sealed class FakeHelperProcess : IHelperProcess
{
    private readonly Action _onExit;
    public FakeHelperProcess(Action onExit) => _onExit = onExit;
    public int Pid => Environment.ProcessId; // pipe sunucusu bu test sureci: kimlik dogrulamasi gecer
    public bool HasExited { get; private set; }
    public bool StuckOnKill { get; set; }
    public int KillCalls { get; private set; }

    public void Kill()
    {
        KillCalls++;
        if (!StuckOnKill) Exit();
    }

    /// <summary>Surec gercekten cikti (ornegin takili surec sonunda oldu).</summary>
    public void Exit()
    {
        if (HasExited) return;
        HasExited = true;
        _onExit();
    }

    public Task<bool> WaitForExitAsync(TimeSpan timeout) => Task.FromResult(HasExited);
    public ValueTask DisposeAsync() => ValueTask.CompletedTask;
}

public sealed class FakeLauncher : IHelperLauncher
{
    private static readonly SecurityIdentifier Me = WindowsIdentity.GetCurrent().User!;
    public ISensorProvider Provider { get; set; } = new FakeSensorProvider();
    public Exception? StartThrows { get; set; }
    /// <summary>true: pipe'i acar, baglantiyi kabul eder ama ASLA cevap vermez (takili yardimci).</summary>
    public bool Silent { get; set; }
    public bool StuckOnKill { get; set; }
    public List<FakeHelperProcess> Processes { get; } = [];
    private int _starts;
    public int Starts => _starts;

    public IHelperProcess Start(string pipeName)
    {
        Interlocked.Increment(ref _starts);
        if (StartThrows is not null) throw StartThrows;

        var cts = new CancellationTokenSource();
        Action stop;
        if (Silent)
        {
            var raw = new NamedPipeServerStream(pipeName, PipeDirection.InOut, 1, PipeTransmissionMode.Byte, PipeOptions.Asynchronous);
            _ = raw.WaitForConnectionAsync(cts.Token).ContinueWith(_ => { });
            stop = () => { cts.Cancel(); raw.Dispose(); };
        }
        else
        {
            var server = new SensorPipeServer(pipeName, Provider, Me, null, TimeSpan.FromMilliseconds(300));
            server.Start();
            var run = server.RunAsync(cts.Token);
            stop = () => { cts.Cancel(); _ = server.DisposeAsync(); _ = run.ContinueWith(_ => { }); };
        }
        var p = new FakeHelperProcess(stop) { StuckOnKill = StuckOnKill };
        Processes.Add(p);
        return p;
    }
}

public class SensorSupervisorTests
{
    private sealed class Clock
    {
        private DateTimeOffset _t = new(2026, 11, 17, 12, 0, 0, TimeSpan.Zero);
        public DateTimeOffset Now() => _t;
        public void Advance(double sec) => _t += TimeSpan.FromSeconds(sec);
    }

    private static SupervisorOptions Opts(int max = 4, double backoffMax = 8) => new(
        ConnectTimeout: TimeSpan.FromSeconds(1), ReadTimeout: TimeSpan.FromMilliseconds(500),
        BackoffBase: TimeSpan.FromSeconds(1), BackoffMax: TimeSpan.FromSeconds(backoffMax),
        MaxConsecutiveFailures: max, CircuitCooldown: TimeSpan.FromSeconds(60), HealthyReadsToReset: 3, KillWait: TimeSpan.FromSeconds(1));

    private static (SensorSupervisor S, FakeLauncher L, Clock C) Make(SupervisorOptions? o = null)
    {
        var l = new FakeLauncher();
        var c = new Clock();
        return (new SensorSupervisor(l, o ?? Opts(), c.Now), l, c);
    }

    private static bool AllUnavailable(IReadOnlyList<SensorReading> r) =>
        r.Count == Enum.GetValues<SensorId>().Length && r.All(x => x.Status == SensorStatus.Unavailable);

    private static async Task<IReadOnlyList<SensorReading>> Read(SensorSupervisor s) => await s.ReadAsync(CancellationToken.None);

    [Fact]
    public async Task Saglikli_yardimci_okumalari_doner_ve_ayni_surec_yeniden_kullanilir()
    {
        var (s, l, _) = Make();
        await using var _s = s;
        for (var i = 0; i < 3; i++)
            Assert.Contains(await Read(s), x => x.Id == SensorId.CpuPackageTempC && x.Status == SensorStatus.Ok && x.Value == 55.5);
        Assert.Equal(1, l.Starts);
        Assert.Equal(0, s.ConsecutiveFailures);
    }

    [Fact]
    public async Task Baslatma_hatasi_firlatmaz_Unavailable_doner_ve_ustel_geri_cekilme_uygulanir()
    {
        var (s, l, c) = Make(Opts(max: 10, backoffMax: 4));
        await using var _s = s;
        l.StartThrows = new InvalidOperationException("exe yok");

        Assert.True(AllUnavailable(await Read(s)));
        Assert.Equal(1, l.Starts);
        Assert.True(AllUnavailable(await Read(s)));
        Assert.Equal(1, l.Starts);                  // geri cekilme (1 sn) icinde yeni baslatma yok

        c.Advance(1); await Read(s);
        Assert.Equal(2, l.Starts);                  // 2. hata -> 2 sn
        c.Advance(1.9); await Read(s);
        Assert.Equal(2, l.Starts);
        c.Advance(0.1); await Read(s);
        Assert.Equal(3, l.Starts);                  // 3. hata -> 4 sn
        c.Advance(4); await Read(s);
        Assert.Equal(4, l.Starts);                  // 4. hata -> min(8, tavan 4) = 4 sn
        c.Advance(3.9); await Read(s);
        Assert.Equal(4, l.Starts);                  // tavan asilmaz/erken denenmez
        c.Advance(0.1); await Read(s);
        Assert.Equal(5, l.Starts);
    }

    [Fact]
    public async Task Devre_kesici_ardisik_hatalardan_sonra_acilir_bekleme_sonrasi_TEK_deneme_yapar()
    {
        var (s, l, c) = Make(Opts(max: 3));
        await using var _s = s;
        l.StartThrows = new InvalidOperationException("x");
        await Read(s); c.Advance(1); await Read(s); c.Advance(2); await Read(s);
        Assert.Equal(3, l.Starts);                  // 3. hata: kesici acildi (60 sn)

        c.Advance(59); await Read(s);
        Assert.Equal(3, l.Starts);
        c.Advance(1); await Read(s);
        Assert.Equal(4, l.Starts);                  // yari acik: tek deneme
        await Read(s); c.Advance(5); await Read(s);
        Assert.Equal(4, l.Starts);                  // basarisiz: kesici yeniden acik, 60 sn beklenir
        c.Advance(55); await Read(s);
        Assert.Equal(5, l.Starts);

        l.StartThrows = null;
        c.Advance(60); await Read(s);
        Assert.Equal(6, l.Starts);                  // surucu/dosya duzeldi: toparlanir
        Assert.Contains(await Read(s), x => x.Status == SensorStatus.Ok);
    }

    [Fact]
    public async Task Takili_yardimci_okuma_zaman_asiminda_OLDURULUR_ve_olduruldukten_sonra_yenisi_baslar()
    {
        var (s, l, c) = Make();
        await using var _s = s;
        l.Silent = true;

        Assert.True(AllUnavailable(await Read(s)));
        Assert.Equal(1, l.Starts);
        Assert.Equal(1, l.Processes[0].KillCalls);
        Assert.True(l.Processes[0].HasExited);

        l.Silent = false;
        c.Advance(1);
        Assert.Contains(await Read(s), x => x.Status == SensorStatus.Ok);
        Assert.Equal(2, l.Starts);
    }

    [Fact]
    public async Task Olum_dogrulanamayan_takili_surec_varken_yeni_yardimci_BASLATILMAZ()
    {
        var (s, l, c) = Make(Opts(max: 20, backoffMax: 1));
        await using var _s = s;
        l.Silent = true;
        l.StuckOnKill = true;

        await Read(s);                                // takili: Kill denendi ama surec cikmadi
        Assert.Equal(1, l.Starts);
        Assert.Equal(1, l.Processes[0].KillCalls);
        Assert.False(l.Processes[0].HasExited);

        l.Silent = false;
        c.Advance(5); await Read(s);
        c.Advance(5); await Read(s);
        Assert.Equal(1, l.Starts);                    // hala yeni surec yok
        Assert.True(l.Processes[0].KillCalls >= 2);   // her turda yeniden oldurmeyi dener

        l.Processes[0].Exit();                        // sonunda cikti
        c.Advance(5);
        Assert.Contains(await Read(s), x => x.Status == SensorStatus.Ok);
        Assert.Equal(2, l.Starts);
    }

    [Fact]
    public async Task Hata_sayaci_yalniz_ardisik_3_saglikli_okumadan_sonra_sifirlanir()
    {
        var (s, l, c) = Make();
        await using var _s = s;
        l.StartThrows = new InvalidOperationException("x");
        await Read(s);
        Assert.Equal(1, s.ConsecutiveFailures);

        l.StartThrows = null;
        c.Advance(1);
        await Read(s); Assert.Equal(1, s.ConsecutiveFailures);   // 1. saglikli
        await Read(s); Assert.Equal(1, s.ConsecutiveFailures);   // 2.
        await Read(s); Assert.Equal(0, s.ConsecutiveFailures);   // 3. -> sifirlandi
    }

    [Fact]
    public async Task Saglikli_seri_arada_hata_olursa_bastan_baslar_ardisik_olmayan_okumalar_sayaci_sifirlamaz()
    {
        var (s, l, c) = Make();
        await using var _s = s;
        l.StartThrows = new InvalidOperationException("x");
        await Read(s);                                  // hata 1
        l.StartThrows = null;
        c.Advance(1);
        await Read(s); await Read(s);                   // seri 2 (sifirlamaya 1 kaldi)
        l.Processes[0].Kill();                          // yardimci coktu
        await Read(s);                                  // hata 2, seri BASA doner
        Assert.Equal(2, s.ConsecutiveFailures);
        c.Advance(2);
        await Read(s);                                  // yeni surec, seri 1 (3 olsaydi yanlislikla sifirlanirdi)
        Assert.Equal(2, s.ConsecutiveFailures);
    }

    [Fact]
    public async Task Yardimci_calisirken_olurse_okuma_firlatmaz_geri_cekilme_sonrasi_yeniden_baslar()
    {
        var (s, l, c) = Make();
        await using var _s = s;
        await Read(s);
        l.Processes[0].Kill();                        // yardimci coktu (pipe kapandi)

        Assert.True(AllUnavailable(await Read(s)));
        Assert.Equal(1, s.ConsecutiveFailures);
        Assert.Equal(1, l.Starts);

        c.Advance(1);
        Assert.Contains(await Read(s), x => x.Status == SensorStatus.Ok);
        Assert.Equal(2, l.Starts);
    }

    [Fact]
    public async Task Saglayici_hatasi_gecerli_yanittir_yardimci_oldurulmez_sayac_artmaz()
    {
        var (s, l, _) = Make();
        await using var _s = s;
        l.Provider = new FakeSensorProvider { Throw = new InvalidOperationException("LHM") };
        var r = await Read(s);
        Assert.All(r, x => Assert.Equal(SensorStatus.ProviderError, x.Status));
        Assert.Equal(1, l.Starts);
        Assert.Equal(0, l.Processes[0].KillCalls);
        Assert.Equal(0, s.ConsecutiveFailures);
    }

    [Fact]
    public async Task Dispose_yardimciyi_oldurur_ve_sonraki_okumalar_Unavailable_doner()
    {
        var (s, l, _) = Make();
        await Read(s);
        await s.DisposeAsync();
        Assert.Equal(1, l.Processes[0].KillCalls);
        Assert.True(AllUnavailable(await Read(s)));
        Assert.Equal(1, l.Starts);
    }

    [Fact]
    public async Task Iptal_tek_izin_verilen_istisnadir()
    {
        var (s, _, _) = Make();
        await using var _s = s;
        using var cts = new CancellationTokenSource();
        cts.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => s.ReadAsync(cts.Token));
    }

    [Fact]
    public async Task Es_zamanli_okumalar_tek_ucus_sirayla_ve_tek_yardimci_surecle_calisir()
    {
        var (s, l, _) = Make();
        await using var _s = s;
        var all = await Task.WhenAll(Enumerable.Range(0, 6).Select(_ => Read(s)));
        Assert.All(all, r => Assert.Contains(r, x => x.Status == SensorStatus.Ok));
        Assert.Equal(1, l.Starts);
    }
}
