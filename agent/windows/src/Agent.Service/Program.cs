using SysMon.Agent;

AgentOptions options;
try
{
    options = AgentOptions.Parse(args);
}
catch (ArgumentException ex)
{
    Console.Error.WriteLine(ex.Message);
    return 2;
}

using var host = AgentHost.Build(options, []);
await host.RunAsync();
return 0;
