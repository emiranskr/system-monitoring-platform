using System.IO.Pipes;
using System.Security.AccessControl;
using System.Security.Principal;
using SysMon.Agent.Sensors;

namespace Agent.Tests.Sensors;

public sealed class FakeSensorProvider : ISensorProvider
{
    public string Name => "fake";
    public IReadOnlyList<SensorReading> Readings { get; set; } = [new(SensorId.CpuPackageTempC, SensorStatus.Ok, 55.5), new(SensorId.CpuFanRpm, SensorStatus.Unsupported, 0)];
    public Exception? Throw { get; set; }
    public bool Hang { get; set; }
    private int _calls;
    public int Calls => _calls;

    public async Task<IReadOnlyList<SensorReading>> ReadAllAsync(CancellationToken ct)
    {
        Interlocked.Increment(ref _calls);
        if (Throw is not null) throw Throw;
        if (Hang) await Task.Delay(Timeout.Infinite); // token'i yok sayan takili saglayici
        return Readings;
    }
}

public sealed record FakeIdentity(int Pid, bool HasExited = false) : IHelperIdentity;

public class SensorPipeTests
{
    private static readonly SecurityIdentifier Me = WindowsIdentity.GetCurrent().User!;
    private static IHelperIdentity ThisProcess => new FakeIdentity(Environment.ProcessId);
    private static string Name() => SensorPipeServer.NewPipeName();

    private static (SensorPipeServer Server, Task Run, CancellationTokenSource Cts) StartServer(string name, ISensorProvider p, SecurityIdentifier? allow = null, int? clientPid = null, TimeSpan? providerTimeout = null)
    {
        var server = new SensorPipeServer(name, p, allow ?? Me, clientPid, providerTimeout ?? TimeSpan.FromSeconds(2));
        server.Start();
        var cts = new CancellationTokenSource();
        return (server, server.RunAsync(cts.Token), cts);
    }

    private static async Task Stop((SensorPipeServer Server, Task Run, CancellationTokenSource Cts) s)
    {
        s.Cts.Cancel();
        try { await s.Run.WaitAsync(TimeSpan.FromSeconds(5)); } catch (OperationCanceledException) { }
        await s.Server.DisposeAsync();
    }

    // ---------- ad ----------

    [Fact]
    public void Pipe_adi_tahmin_edilemez_her_seferinde_yeni_ve_en_az_128_bit_rastgelelik()
    {
        var names = Enumerable.Range(0, 50).Select(_ => SensorPipeServer.NewPipeName()).ToList();
        Assert.Equal(50, names.Distinct().Count());
        Assert.All(names, n => { Assert.StartsWith("sysmon-sensors-", n); Assert.Equal("sysmon-sensors-".Length + 32, n.Length); });
    }

    // ---------- uctan uca ----------

    [Fact]
    public async Task Uctan_uca_okuma_dogru_sunucu_PID_si_ile_calisir_ve_tekrar_okunabilir()
    {
        var name = Name();
        var s = StartServer(name, new FakeSensorProvider());
        try
        {
            await using var c = await SensorPipeClient.ConnectAsync(name, ThisProcess, TimeSpan.FromSeconds(5), CancellationToken.None);
            for (var i = 0; i < 3; i++)
            {
                var r = await c.ReadAllAsync(TimeSpan.FromSeconds(2), CancellationToken.None);
                Assert.Equal(2, r.Count);
                Assert.Equal(55.5, r.Single(x => x.Id == SensorId.CpuPackageTempC).Value);
            }
        }
        finally { await Stop(s); }
    }

    [Fact]
    public async Task Istemci_baglanip_sunucu_beklemeye_baslamadan_kopsa_sunucu_COKMEZ_ve_sonraki_istemciye_hizmet_verir()
    {
        // KOK NEDEN (CI'da yakalandi, aralikli "yetim kalmaz" testi): istemci sunucu WaitForConnection'a gelmeden baglanip kapanirsa
        // ConnectNamedPipe ERROR_NO_DATA ("The pipe is being closed") doner; bu IOException RunAsync'ten kontrolsuz cikip yardimci sureci oldurdu.
        var name = Name();
        var server = new SensorPipeServer(name, new FakeSensorProvider(), Me, null, TimeSpan.FromSeconds(2));
        server.Start();
        using (var early = new NamedPipeClientStream(".", name, PipeDirection.InOut, PipeOptions.Asynchronous))
        {
            await early.ConnectAsync(3000);
        }   // hemen kapat: sunucu henuz kabul etmedi
        var cts = new CancellationTokenSource();
        var run = server.RunAsync(cts.Token);
        try
        {
            await using var c = await SensorPipeClient.ConnectAsync(name, ThisProcess, TimeSpan.FromSeconds(5), CancellationToken.None);
            var r = await c.ReadAllAsync(TimeSpan.FromSeconds(2), CancellationToken.None);
            Assert.Equal(2, r.Count);
            Assert.False(run.IsFaulted, "sunucu dongusu cokmemeli");
        }
        finally
        {
            cts.Cancel();
            try { await run.WaitAsync(TimeSpan.FromSeconds(5)); } catch (OperationCanceledException) { }
            await server.DisposeAsync();
        }
    }

    // ---------- ACL ----------

    [Fact]
    public async Task ACL_canli_pipein_gercek_guvenlik_tanimlayicisinda_yalniz_beklenen_hesap_ve_SYSTEM_vardir()
    {
        var name = Name();
        var s = StartServer(name, new FakeSensorProvider());
        try
        {
            var rules = s.Server.DescribeAcl();
            var allow = rules.Where(r => r.Type == AccessControlType.Allow).Select(r => r.Sid).ToHashSet();
            Assert.Equal(2, rules.Count);
            Assert.Contains(Me, allow);
            Assert.Contains(new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null), allow);
            Assert.DoesNotContain(new SecurityIdentifier(WellKnownSidType.WorldSid, null), allow);                  // Everyone
            Assert.DoesNotContain(new SecurityIdentifier(WellKnownSidType.AuthenticatedUserSid, null), allow);
            Assert.DoesNotContain(new SecurityIdentifier(WellKnownSidType.BuiltinUsersSid, null), allow);
            Assert.DoesNotContain(new SecurityIdentifier(WellKnownSidType.AnonymousSid, null), allow);
            // beklenen hesap yeni pipe ornegi OLUSTURAMAZ (squatting): CreateNewInstance yok
            var mine = rules.Single(r => r.Sid == Me);
            Assert.False(mine.Rights.HasFlag(PipeAccessRights.CreateNewInstance));
        }
        finally { await Stop(s); }
    }

    [Fact]
    public async Task ACL_yetkisiz_kimlik_baglanamaz_isletim_sistemi_reddeder()
    {
        var name = Name();
        var foreign = new SecurityIdentifier("S-1-5-21-1-2-3-4242"); // bu kullanici DEGIL
        var s = StartServer(name, new FakeSensorProvider(), allow: foreign);
        try
        {
            var ex = await Assert.ThrowsAsync<SensorPipeException>(() => SensorPipeClient.ConnectAsync(name, ThisProcess, TimeSpan.FromSeconds(3), CancellationToken.None));
            Assert.Equal(SensorPipeError.ConnectFailed, ex.Error);
            Assert.IsType<UnauthorizedAccessException>(ex.InnerException);
        }
        finally { await Stop(s); }
    }

    // ---------- squatting ----------

    [Fact]
    public async Task Sunucu_ayni_ada_onceden_acilmis_pipe_varsa_baslamaz_FirstPipeInstance()
    {
        var name = Name();
        await using var squatter = new NamedPipeServerStream(name, PipeDirection.InOut, 1, PipeTransmissionMode.Byte, PipeOptions.Asynchronous);
        var server = new SensorPipeServer(name, new FakeSensorProvider(), Me, null, TimeSpan.FromSeconds(1));
        var ex = Assert.Throws<SensorPipeException>(() => server.Start());
        Assert.Equal(SensorPipeError.NameInUse, ex.Error);
        await server.DisposeAsync();
    }

    [Fact]
    public async Task Sunucu_squatter_cok_ornekli_ve_ayni_kullanici_olsa_bile_baslamaz_yalniz_FirstPipeInstance_korur()
    {
        var name = Name();
        // saldirgan ayni kullanici ve cok ornekli pipe aciyor: bayrak olmasa ikinci ornek olarak katilinabilirdi
        await using var squatter = new NamedPipeServerStream(name, PipeDirection.InOut, NamedPipeServerStream.MaxAllowedServerInstances, PipeTransmissionMode.Byte, PipeOptions.Asynchronous);
        var server = new SensorPipeServer(name, new FakeSensorProvider(), Me, null, TimeSpan.FromSeconds(1));
        try
        {
            var ex = Assert.Throws<SensorPipeException>(() => server.Start());
            Assert.Equal(SensorPipeError.NameInUse, ex.Error);
        }
        finally { await server.DisposeAsync(); }
    }

    [Fact]
    public async Task Istemci_sahte_pipe_sunucusuna_baglaninca_PID_uyusmadigi_icin_reddeder_ve_hicbir_bayt_yazmaz()
    {
        var name = Name();
        await using var fake = new NamedPipeServerStream(name, PipeDirection.InOut, 1, PipeTransmissionMode.Byte, PipeOptions.Asynchronous);
        var accept = fake.WaitForConnectionAsync();

        // beklenen yardimci PID'si bu surecinkinden FARKLI: sahte pipe'in sahibi (bu surec) beklenen degil
        var ex = await Assert.ThrowsAsync<SensorPipeException>(() =>
            SensorPipeClient.ConnectAsync(name, new FakeIdentity(Environment.ProcessId + 1), TimeSpan.FromSeconds(3), CancellationToken.None));
        Assert.Equal(SensorPipeError.ServerIdentityMismatch, ex.Error);

        await accept.WaitAsync(TimeSpan.FromSeconds(3));
        var buf = new byte[16];
        using var cts = new CancellationTokenSource(300);
        var n = 0;
        try { n = await fake.ReadAsync(buf, cts.Token); } catch (OperationCanceledException) { }
        Assert.Equal(0, n); // protokol baslamadi: sahte sunucu tek bayt almadi (istemci kapandi / yazmadi)
    }

    [Fact]
    public async Task Cikmis_yardimci_sureci_ile_baglanti_reddedilir()
    {
        var name = Name();
        var s = StartServer(name, new FakeSensorProvider());
        try
        {
            var ex = await Assert.ThrowsAsync<SensorPipeException>(() =>
                SensorPipeClient.ConnectAsync(name, new FakeIdentity(Environment.ProcessId, HasExited: true), TimeSpan.FromSeconds(3), CancellationToken.None));
            Assert.Equal(SensorPipeError.ServerIdentityMismatch, ex.Error);
        }
        finally { await Stop(s); }
    }

    [Fact]
    public async Task Sunucu_beklenen_istemci_PID_sinin_disindaki_istemciyi_dusurur_saglayici_cagrilmaz()
    {
        var name = Name();
        var provider = new FakeSensorProvider();
        var s = StartServer(name, provider, clientPid: Environment.ProcessId + 1);
        try
        {
            await using var c = await SensorPipeClient.ConnectAsync(name, ThisProcess, TimeSpan.FromSeconds(3), CancellationToken.None);
            await Assert.ThrowsAnyAsync<Exception>(() => c.ReadAllAsync(TimeSpan.FromSeconds(1), CancellationToken.None));
            Assert.Equal(0, provider.Calls);
        }
        finally { await Stop(s); }
    }

    // ---------- saglayici hatalari ----------

    [Fact]
    public async Task Saglayici_firlatirsa_tum_sensorler_ProviderError_doner_ve_sunucu_sonraki_istege_hizmet_verir()
    {
        var name = Name();
        var provider = new FakeSensorProvider { Throw = new InvalidOperationException("LHM patladi") };
        var s = StartServer(name, provider);
        try
        {
            await using var c = await SensorPipeClient.ConnectAsync(name, ThisProcess, TimeSpan.FromSeconds(3), CancellationToken.None);
            var r1 = await c.ReadAllAsync(TimeSpan.FromSeconds(2), CancellationToken.None);
            Assert.All(r1, x => Assert.Equal(SensorStatus.ProviderError, x.Status));
            provider.Throw = null;
            var r2 = await c.ReadAllAsync(TimeSpan.FromSeconds(2), CancellationToken.None);
            Assert.Contains(r2, x => x.Status == SensorStatus.Ok);
        }
        finally { await Stop(s); }
    }

    [Fact]
    public async Task Saglayici_gecersiz_veri_dondururse_ProviderError_olur()
    {
        var name = Name();
        var provider = new FakeSensorProvider { Readings = [new(SensorId.CpuPackageTempC, SensorStatus.Ok, double.NaN)] };
        var s = StartServer(name, provider);
        try
        {
            await using var c = await SensorPipeClient.ConnectAsync(name, ThisProcess, TimeSpan.FromSeconds(3), CancellationToken.None);
            Assert.All(await c.ReadAllAsync(TimeSpan.FromSeconds(2), CancellationToken.None), x => Assert.Equal(SensorStatus.ProviderError, x.Status));
        }
        finally { await Stop(s); }
    }

    [Fact]
    public async Task Takili_saglayici_zaman_asiminda_ProviderError_ve_ikinci_okuma_yigilmaz()
    {
        var name = Name();
        var provider = new FakeSensorProvider { Hang = true };
        var s = StartServer(name, provider, providerTimeout: TimeSpan.FromMilliseconds(200));
        try
        {
            await using var c = await SensorPipeClient.ConnectAsync(name, ThisProcess, TimeSpan.FromSeconds(3), CancellationToken.None);
            Assert.All(await c.ReadAllAsync(TimeSpan.FromSeconds(3), CancellationToken.None), x => Assert.Equal(SensorStatus.ProviderError, x.Status));
            Assert.All(await c.ReadAllAsync(TimeSpan.FromSeconds(3), CancellationToken.None), x => Assert.Equal(SensorStatus.ProviderError, x.Status));
            Assert.Equal(1, provider.Calls); // takili cagri bitmeden yeni saglayici cagrisi baslatilmadi
        }
        finally { await Stop(s); }
    }

    // ---------- bozuk istemci / sunucu ----------

    [Fact]
    public async Task Baglanip_hemen_kapanan_istemciler_sunucuyu_COKERTMEZ_sonraki_gecerli_istemci_hizmet_alir()
    {
        var name = Name();
        var s = StartServer(name, new FakeSensorProvider());
        try
        {
            for (var i = 0; i < 200; i++)
            {
                // baglan ve HICBIR sey yazmadan hemen kapat (sunucu WaitForConnection/Disconnect yarisi)
                var raw = new NamedPipeClientStream(".", name, PipeDirection.InOut, PipeOptions.Asynchronous);
                await raw.ConnectAsync(3000);
                raw.Dispose();
            }
            Assert.False(s.Run.IsCompleted, "sunucu dongusu coktu/bitti: " + s.Run.Exception);
            await using var c = await SensorPipeClient.ConnectAsync(name, ThisProcess, TimeSpan.FromSeconds(5), CancellationToken.None);
            Assert.NotEmpty(await c.ReadAllAsync(TimeSpan.FromSeconds(5), CancellationToken.None));
            Assert.False(s.Run.IsCompleted);
        }
        finally { await Stop(s); }
    }

    [Fact]
    public async Task Bozuk_istek_baglantiyi_dusurur_sunucu_yeni_istemciye_hizmet_vermeye_devam_eder()
    {
        var name = Name();
        var s = StartServer(name, new FakeSensorProvider());
        try
        {
            await using (var raw = new NamedPipeClientStream(".", name, PipeDirection.InOut, PipeOptions.Asynchronous))
            {
                await raw.ConnectAsync(3000);
                await raw.WriteAsync(new byte[] { 0xFF, 0xFF, 0x00 });
                await raw.FlushAsync();
                var buf = new byte[8];
                Assert.Equal(0, await raw.ReadAsync(buf).AsTask().WaitAsync(TimeSpan.FromSeconds(3))); // sunucu kapatti
            }
            await using var c = await SensorPipeClient.ConnectAsync(name, ThisProcess, TimeSpan.FromSeconds(3), CancellationToken.None);
            Assert.NotEmpty(await c.ReadAllAsync(TimeSpan.FromSeconds(2), CancellationToken.None));
        }
        finally { await Stop(s); }
    }

    [Fact]
    public async Task Istemci_zaman_asiminda_baglantiyi_kapatir_gec_gelen_yanit_sonraki_istege_karismaz()
    {
        var name = Name();
        await using var fake = new NamedPipeServerStream(name, PipeDirection.InOut, 1, PipeTransmissionMode.Byte, PipeOptions.Asynchronous);
        var accept = fake.WaitForConnectionAsync();
        await using var c = await SensorPipeClient.ConnectAsync(name, ThisProcess, TimeSpan.FromSeconds(3), CancellationToken.None);
        await accept;

        // sahte sunucu istegi alir ama CEVAP VERMEZ
        await Assert.ThrowsAsync<SensorPipeException>(() => c.ReadAllAsync(TimeSpan.FromMilliseconds(250), CancellationToken.None));
        // gec yanit gonderse bile istemci artik bozuk sayilir: yeniden kullanilamaz
        await fake.WriteAsync(SensorProtocol.EncodeResponse([new SensorReading(SensorId.CpuPackageTempC, SensorStatus.Ok, 1)])).AsTask().ContinueWith(_ => { });
        var ex = await Assert.ThrowsAsync<SensorPipeException>(() => c.ReadAllAsync(TimeSpan.FromSeconds(1), CancellationToken.None));
        Assert.Equal(SensorPipeError.Broken, ex.Error);
    }

    [Fact]
    public async Task Kotu_niyetli_sunucudan_4KiB_ustu_yanit_reddedilir_ve_istemci_bozuk_olur()
    {
        var name = Name();
        await using var fake = new NamedPipeServerStream(name, PipeDirection.InOut, 1, PipeTransmissionMode.Byte, PipeOptions.Asynchronous);
        var accept = fake.WaitForConnectionAsync();
        await using var c = await SensorPipeClient.ConnectAsync(name, ThisProcess, TimeSpan.FromSeconds(3), CancellationToken.None);
        await accept;
        var req = new byte[2];
        var read = fake.ReadExactlyAsync(req).AsTask();
        var call = c.ReadAllAsync(TimeSpan.FromSeconds(3), CancellationToken.None);
        await read;
        await fake.WriteAsync(BitConverter.GetBytes((uint)SensorProtocol.MaxPayloadBytes + 1));
        var ex = await Assert.ThrowsAsync<SensorProtocolException>(() => call);
        Assert.Equal(SensorProtocolError.TooLarge, ex.Error);
        Assert.Equal(SensorPipeError.Broken, (await Assert.ThrowsAsync<SensorPipeException>(() => c.ReadAllAsync(TimeSpan.FromSeconds(1), CancellationToken.None))).Error);
    }

    [Fact]
    public async Task Ayni_anda_ikinci_okuma_Busy_ile_reddedilir_tek_ucus()
    {
        var name = Name();
        var provider = new FakeSensorProvider { Hang = true };
        var s = StartServer(name, provider, providerTimeout: TimeSpan.FromSeconds(3));
        try
        {
            await using var c = await SensorPipeClient.ConnectAsync(name, ThisProcess, TimeSpan.FromSeconds(3), CancellationToken.None);
            var first = c.ReadAllAsync(TimeSpan.FromSeconds(5), CancellationToken.None);
            await Task.Delay(100);
            var ex = await Assert.ThrowsAsync<SensorPipeException>(() => c.ReadAllAsync(TimeSpan.FromSeconds(1), CancellationToken.None));
            Assert.Equal(SensorPipeError.Busy, ex.Error);
            await first.WaitAsync(TimeSpan.FromSeconds(6));
        }
        finally { await Stop(s); }
    }
}
