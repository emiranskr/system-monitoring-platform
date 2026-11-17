using System.Diagnostics;
using System.IO.Pipes;
using System.Security.Principal;
using SysMon.Agent.Sensors;

namespace Agent.Tests.Sensors;

/// <summary>
/// GERCEK surecler (uretim yardimcisi + test-only sahte yardimci). SYSMON_TEST_MODE ortam degiskeni surece miras kalir:
/// testler ayni koleksiyonda sirayla calisir. Yonetici/surucu/UAC yok; standart kullanici yeterli.
/// </summary>
[CollectionDefinition("SensorHelperProcess", DisableParallelization = true)]
public class SensorHelperProcessCollection;

[Collection("SensorHelperProcess")]
public sealed class SensorHelperIntegrationTests : IDisposable
{
    private static readonly SecurityIdentifier Me = WindowsIdentity.GetCurrent().User!;
    private static string Exe(string name)
    {
        var p = Path.Combine(AppContext.BaseDirectory, name);
        Assert.True(File.Exists(p), $"yardimci exe yok: {p} (test projesi referanslari)");
        return p;
    }

    private static string ProdHelper => Exe("Agent.SensorHelper.exe");
    private static string TestHelper => Exe("Agent.TestSensorHelper.exe");

    private sealed class CapturingLauncher(string exe) : IHelperLauncher
    {
        private readonly ProcessHelperLauncher _inner = new(exe, Me, Environment.ProcessId, requireSecurePermissions: false);
        public List<ProcessHelper> Started { get; } = [];
        public IHelperProcess Start(string pipeName)
        {
            var p = (ProcessHelper)_inner.Start(pipeName);
            Started.Add(p);
            return p;
        }
    }

    private static SupervisorOptions Fast() => new(
        ConnectTimeout: TimeSpan.FromSeconds(8), ReadTimeout: TimeSpan.FromSeconds(3),
        BackoffBase: TimeSpan.FromMilliseconds(200), BackoffMax: TimeSpan.FromSeconds(2),
        MaxConsecutiveFailures: 5, CircuitCooldown: TimeSpan.FromSeconds(30), HealthyReadsToReset: 3, KillWait: TimeSpan.FromSeconds(5));

    public void Dispose() => Environment.SetEnvironmentVariable("SYSMON_TEST_MODE", null);

    private static bool AllUnavailable(IReadOnlyList<SensorReading> r) => r.Count > 0 && r.All(x => x.Status == SensorStatus.Unavailable);

    // ---------- uretim yardimcisi ----------

    [Fact]
    public async Task Uretim_yardimcisi_pipe_uzerinden_Null_saglayiciyla_tum_sensorleri_Unavailable_bildirir_ve_Dispose_oldurur()
    {
        var name = SensorPipeServer.NewPipeName();
        var launcher = new ProcessHelperLauncher(ProdHelper, Me, Environment.ProcessId, requireSecurePermissions: false);
        var proc = (ProcessHelper)launcher.Start(name);
        var pid = proc.Pid;
        using var second = Process.GetProcessById(pid); // ikinci handle: Dispose sonrasi dogrulama
        await using (var client = await SensorPipeClient.ConnectAsync(name, proc, TimeSpan.FromSeconds(10), CancellationToken.None))
        {
            var r = await client.ReadAllAsync(TimeSpan.FromSeconds(3), CancellationToken.None);
            Assert.Equal(Enum.GetValues<SensorId>().Length, r.Count);
            Assert.All(r, x => Assert.Equal(SensorStatus.Unavailable, x.Status));
        }
        Assert.False(proc.HasExited);

        await proc.DisposeAsync(); // KILL_ON_JOB_CLOSE
        Assert.True(second.WaitForExit(8000), "yardimci Dispose sonrasi hala yasiyor");
    }

    [Fact]
    public void Uretim_yardimcisi_gecersiz_arguman_ile_cikis_kodu_2_verir()
    {
        using var p = Process.Start(new ProcessStartInfo(ProdHelper, "--bogus x") { UseShellExecute = false, CreateNoWindow = true })!;
        Assert.True(p.WaitForExit(8000));
        Assert.Equal(2, p.ExitCode);
    }

    [Fact]
    public void Uretim_yardimcisi_ebeveyn_cikinca_kendiliginden_cikar_yetim_kalmaz()
    {
        using var parent = Process.Start(new ProcessStartInfo("ping.exe", "-n 4 127.0.0.1") { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true })!;
        var name = SensorPipeServer.NewPipeName();
        using var helper = Process.Start(new ProcessStartInfo(ProdHelper, $"--pipe {name} --parent-pid {parent.Id} --allow-sid {Me.Value}") { UseShellExecute = false, CreateNoWindow = true })!;
        Assert.True(helper.WaitForExit(45000), "yardimci ebeveyn cikinca cikmadi");
        Assert.Equal(0, helper.ExitCode);
        parent.WaitForExit(2000);
    }

    [Fact]
    public async Task Uretim_yardimcisi_pipe_adi_onceden_kapilmissa_baslamaz_cikis_kodu_3()
    {
        var name = SensorPipeServer.NewPipeName();
        await using var squatter = new NamedPipeServerStream(name, PipeDirection.InOut, 1, PipeTransmissionMode.Byte, PipeOptions.Asynchronous);
        using var helper = Process.Start(new ProcessStartInfo(ProdHelper, $"--pipe {name} --parent-pid {Environment.ProcessId} --allow-sid {Me.Value}") { UseShellExecute = false, CreateNoWindow = true })!;
        Assert.True(helper.WaitForExit(10000));
        Assert.Equal(3, helper.ExitCode);
    }

    [Fact]
    public async Task Supervisor_uretim_yardimcisiyla_uctan_uca_calisir_ve_agent_sagligini_etkilemez()
    {
        var launcher = new CapturingLauncher(ProdHelper);
        await using var s = new SensorSupervisor(launcher, Fast());
        Assert.True(AllUnavailable(await s.ReadAsync(CancellationToken.None)));
        Assert.True(AllUnavailable(await s.ReadAsync(CancellationToken.None)));
        Assert.Single(launcher.Started);
        Assert.False(launcher.Started[0].HasExited);
        Assert.Equal(0, s.ConsecutiveFailures);
    }

    // ---------- sahte (kotu) yardimcilar ----------

    [Fact]
    public async Task Test_yardimcisi_ok_modunda_gercek_surec_PID_dogrulamasiyla_deger_doner()
    {
        Environment.SetEnvironmentVariable("SYSMON_TEST_MODE", "ok");
        var launcher = new CapturingLauncher(TestHelper);
        await using var s = new SensorSupervisor(launcher, Fast());
        var r = await s.ReadAsync(CancellationToken.None);
        Assert.Contains(r, x => x.Id == SensorId.CpuPackageTempC && x.Status == SensorStatus.Ok && x.Value == 61.0);
    }

    [Fact]
    public async Task Yardimci_cokerse_supervisor_firlatmaz_Unavailable_doner_hata_sayilir()
    {
        Environment.SetEnvironmentVariable("SYSMON_TEST_MODE", "crash");
        var launcher = new CapturingLauncher(TestHelper);
        await using var s = new SensorSupervisor(launcher, Fast());
        Assert.True(AllUnavailable(await s.ReadAsync(CancellationToken.None)));
        Assert.Equal(1, s.ConsecutiveFailures);
        Assert.True(launcher.Started[0].HasExited);
    }

    [Fact]
    public async Task Yardimci_takilirsa_zaman_asiminda_surec_gercekten_OLDURULUR()
    {
        Environment.SetEnvironmentVariable("SYSMON_TEST_MODE", "hang");
        var launcher = new CapturingLauncher(TestHelper);
        await using var s = new SensorSupervisor(launcher, Fast());
        Assert.True(AllUnavailable(await s.ReadAsync(CancellationToken.None)));
        Assert.Equal(1, s.ConsecutiveFailures);
        Assert.True(await launcher.Started[0].WaitForExitAsync(TimeSpan.FromSeconds(5)), "takili yardimci olduruldu mu");
    }

    [Fact]
    public async Task Yardimci_boyut_siniri_asan_yanit_gonderirse_reddedilir_ve_surec_olur()
    {
        Environment.SetEnvironmentVariable("SYSMON_TEST_MODE", "garbage");
        var launcher = new CapturingLauncher(TestHelper);
        await using var s = new SensorSupervisor(launcher, Fast());
        Assert.True(AllUnavailable(await s.ReadAsync(CancellationToken.None)));
        Assert.Equal(1, s.ConsecutiveFailures);
        Assert.True(await launcher.Started[0].WaitForExitAsync(TimeSpan.FromSeconds(5)));
    }

    // ---------- Job Object ----------

    [Fact]
    public async Task Job_Object_yardimcinin_cocuk_surec_olusturmasini_engeller_kontrol_Job_disinda_cocuk_calisir()
    {
        Environment.SetEnvironmentVariable("SYSMON_TEST_MODE", "spawn");

        // kontrol: Job disinda dogrudan baslatilinca cocuk surec calisir (cikis kodu 7)
        using (var direct = Process.Start(new ProcessStartInfo(TestHelper, $"--pipe {SensorPipeServer.NewPipeName()} --parent-pid {Environment.ProcessId} --allow-sid {Me.Value}") { UseShellExecute = false, CreateNoWindow = true })!)
        {
            Assert.True(direct.WaitForExit(15000));
            Assert.Equal(7, direct.ExitCode);
        }

        // Job icinde: cocuk surec ENGELLENIR (cikis kodu 7 olamaz)
        var launcher = new ProcessHelperLauncher(TestHelper, Me, Environment.ProcessId, requireSecurePermissions: false);
        var proc = (ProcessHelper)launcher.Start(SensorPipeServer.NewPipeName());
        Assert.True(await proc.WaitForExitAsync(TimeSpan.FromSeconds(15)));
        Assert.NotEqual(7, proc.ExitCode);
        await proc.DisposeAsync();
    }

    [Fact]
    public void Launcher_gecersiz_yol_ve_guvensiz_izinle_baslatmayi_reddeder()
    {
        var rel = new ProcessHelperLauncher("Agent.SensorHelper.exe", Me, Environment.ProcessId, requireSecurePermissions: false);
        Assert.Equal(HelperExeError.NotAbsolute, Assert.Throws<HelperExeException>(() => rel.Start(SensorPipeServer.NewPipeName())).Error);

        var insecure = new ProcessHelperLauncher(ProdHelper, Me, Environment.ProcessId, requireSecurePermissions: true); // test cikti dizini kullanici yazimli
        Assert.Equal(HelperExeError.UntrustedPermissions, Assert.Throws<HelperExeException>(() => insecure.Start(SensorPipeServer.NewPipeName())).Error);
    }
}
