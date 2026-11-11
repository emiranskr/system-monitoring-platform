using System.Security.Cryptography;
using SysMon.Agent;
using SysMon.Agent.Transport;

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

// Bootstrap: duz metin token dosyasini korumali depoya tasi, duz metin dosyayi sil ve cik.
if (options.ImportToken is not null)
{
    if (!OperatingSystem.IsWindows())
    {
        Console.Error.WriteLine("--import-token yalnizca Windows'ta desteklenir.");
        return 2;
    }
    try
    {
        var store = new TokenStore(AgentPaths.TokenStorePath(options),
            options.TokenReader is null ? null : [options.TokenReader]);
        TokenImporter.Import(options.ImportToken, store);
        Console.WriteLine($"Token korumali depoya yazildi: {store.Path}");
        return 0;
    }
    catch (Exception ex) when (ex is ArgumentException or IOException or InvalidOperationException or UnauthorizedAccessException or CryptographicException)
    {
        Console.Error.WriteLine($"Token iceri aktarilamadi: {ex.Message}");
        return 1;
    }
}

using var host = AgentHost.Build(options, []);
await host.RunAsync();
return 0;
