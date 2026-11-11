using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;

namespace SysMon.Agent;

public static class AgentHost
{
    public static IHost Build(AgentOptions options, string[] args)
    {
        var builder = Host.CreateApplicationBuilder(args);
        builder.Services.AddSingleton(options);
        builder.Services.AddHostedService<AgentWorker>();
        if (options.ServiceMode)
        {
            builder.Services.AddWindowsService(o => o.ServiceName = "SysMonAgent");
        }
        return builder.Build();
    }
}
