using Microsoft.Extensions.Hosting;
using SysMon.Agent;
using SysMon.Agent.Transport;

namespace Agent.Tests;

public sealed class HostTests : IDisposable
{
    private readonly string _dataDir = Path.Combine(Path.GetTempPath(), "sysmon-host-" + Guid.NewGuid().ToString("N"));

    public void Dispose()
    {
        if (Directory.Exists(_dataDir)) Directory.Delete(_dataDir, true);
    }

    [Fact]
    public async Task Host_konsol_modunda_temiz_baslar_ve_durur()
    {
        using var host = AgentHost.Build(new AgentOptions(false, false, DataDir: _dataDir), []);
        await host.StartAsync();
        await host.StopAsync();
        Assert.NotNull(host.Services.GetService(typeof(IHostApplicationLifetime)));
    }

    [Fact]
    public async Task Host_gercek_collectorlarla_calisir_ve_kapanista_spoola_yazar()
    {
        if (!OperatingSystem.IsWindows()) return;
        using var host = AgentHost.Build(new AgentOptions(false, false, DataDir: _dataDir), []);
        await host.StartAsync();
        await Task.Delay(2500);
        await host.StopAsync();

        var segs = Directory.GetFiles(Path.Combine(_dataDir, "spool"), "seg-*.jsonl");
        Assert.NotEmpty(segs);
        var text = string.Concat(segs.Select(File.ReadAllText));
        Assert.Contains("mem.used_pct", text);
        Assert.Contains("disk.C.used_pct", text);
    }

    [Fact]
    public async Task I3_Spool_yazma_hatasi_uretim_kablolamasinda_gunluge_yazilir()
    {
        if (!OperatingSystem.IsWindows()) return;
        using var host = AgentHost.Build(new AgentOptions(false, false, DataDir: _dataDir), []);
        await host.StartAsync();
        var spoolDir = Path.Combine(_dataDir, "spool");
        await TestUtil.WaitUntil(() => Directory.Exists(spoolDir) && Directory.GetFiles(spoolDir, "seg-*.jsonl").Length > 0, 30_000,
            "ilk batch yazilmadi");

        string text;
        using (new FileStream(Directory.GetFiles(spoolDir, "seg-*.jsonl")[0], FileMode.Open, FileAccess.Read, FileShare.None)) // yazmayi engelle
        {
            var logPath = Path.Combine(_dataDir, "logs", "agent.log");
            await TestUtil.WaitUntil(() => File.Exists(logPath) && ReadShared(logPath).Contains("spool'a yazilamadi"), 30_000,
                "Enqueue hatasi gunluge yazilmadi");
            text = ReadShared(logPath);
        }
        await host.StopAsync();

        Assert.Contains("spool'a yazilamadi", text);
    }

    private static string ReadShared(string path)
    {
        using var fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
        using var sr = new StreamReader(fs);
        return sr.ReadToEnd();
    }

    [Fact]
    public async Task Host_baska_ornek_calisiyorsa_InstanceLock_nedeniyle_guvenle_durur()
    {
        if (!OperatingSystem.IsWindows()) return;
        using var existingLock = InstanceLock.TryAcquire(_dataDir);
        Assert.NotNull(existingLock);

        using var host = AgentHost.Build(new AgentOptions(false, false, DataDir: _dataDir), []);
        // Host baslatildiginda kilit alamayacagi icin StopApplication cagirilir ve host kendiliginden durur
        await host.StartAsync();
        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        await host.WaitForShutdownAsync(cts.Token);

        try
        {
            Assert.Equal(1, Environment.ExitCode);
            Assert.False(Directory.Exists(Path.Combine(_dataDir, "spool")));
        }
        finally { Environment.ExitCode = 0; } // statik deger diger testlere sizmasin
    }
}
