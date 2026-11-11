using Microsoft.Extensions.Hosting;
using SysMon.Agent;

namespace Agent.Tests;

public class HostTests
{
    [Fact]
    public async Task Host_konsol_modunda_temiz_baslar_ve_durur()
    {
        using var host = AgentHost.Build(AgentOptions.Parse([]), []);
        await host.StartAsync();
        await host.StopAsync();
        Assert.NotNull(host.Services.GetService(typeof(IHostApplicationLifetime)));
    }
}
