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
    public async Task Host_baska_ornek_calisiyorsa_InstanceLock_nedeniyle_guvenle_durur()
    {
        if (!OperatingSystem.IsWindows()) return;
        using var existingLock = InstanceLock.TryAcquire(_dataDir);
        Assert.NotNull(existingLock);

        using var host = AgentHost.Build(new AgentOptions(false, false, DataDir: _dataDir), []);
        // Host baslatildiginda kilit alamayacagi icin ExecuteAsync hemen sonlanmali ve spool olusmamali
        await host.StartAsync();
        await Task.Delay(500);
        await host.StopAsync();

        Assert.False(Directory.Exists(Path.Combine(_dataDir, "spool")));
    }
}
