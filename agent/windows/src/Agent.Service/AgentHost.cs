using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

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

        // Windows Olay Gunlugu sağlayicisi kayitli bir olay kaynagi ister; dusuk yetkili servis hesabi
        // kaynak olusturamaz ("Unable to log .NET application events"). Bunun yerine konsol + dosya gunlugu.
        // ClearProviders, AddWindowsService'in eklediklerinden SONRA cagrilmali.
        builder.Logging.ClearProviders();
        builder.Logging.AddConsole();
        builder.Logging.AddProvider(new FileLoggerProvider(Path.Combine(AgentPaths.DataDir(options), "logs", "agent.log")));
        return builder.Build();
    }
}
