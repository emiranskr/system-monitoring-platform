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

// Kayit: tek kullanimlik belirec -> cihaz kimlik bilgisi (korumali depoya yazilir). Ayrintilar: EnrollCommand.
if (options.EnrollTokenFile is not null)
{
    if (!OperatingSystem.IsWindows())
    {
        Console.Error.WriteLine("--enroll yalnizca Windows'ta desteklenir.");
        return 2;
    }
    try
    {
        return await EnrollCommand.RunAsync(options, Console.Out, Console.Error);
    }
    catch (Exception ex) when (ex is ArgumentException or IOException or InvalidOperationException or UnauthorizedAccessException or CryptographicException)
    {
        Console.Error.WriteLine($"Kayit tamamlanamadi: {ex.Message}");
        return 1;
    }
}

// Kimlik bilgisi dondurme (kayitli cihaz): RotateCommand.
if (options.Rotate)
{
    if (!OperatingSystem.IsWindows())
    {
        Console.Error.WriteLine("--rotate yalnizca Windows'ta desteklenir.");
        return 2;
    }
    try
    {
        return await RotateCommand.RunAsync(options, Console.Out, Console.Error);
    }
    catch (Exception ex) when (ex is ArgumentException or IOException or InvalidOperationException or UnauthorizedAccessException or CryptographicException)
    {
        Console.Error.WriteLine($"Dondurma tamamlanamadi: {ex.Message}");
        return 1;
    }
}

// Hizli basarisizlik: izin verilmeyen sunucu adresi (ornegin Release'te http) ana bilgisayar kurulmadan reddedilir. Aksi halde
// istisna Worker icinde kaybolur ve surec "basarili" (0) diye durur: yanlis yapilandirma SCM/operator icin gorunmez olurdu.
if (options.Server is { } server && (!Uri.TryCreate(server, UriKind.Absolute, out var serverUri) || !ServerUrlPolicy.IsAllowed(serverUri, options)))
{
    Console.Error.WriteLine("--server adresine izin verilmiyor: https gerekir (http yalnizca Debug derlemesinde, loopback ve --allow-insecure-loopback ile).");
    return 2;
}

using var host = AgentHost.Build(options, []);
await host.RunAsync();
// Worker (ornegin InstanceLock alinamadi) Environment.ExitCode'u ayarlar; int donusu bunu ezmemeli.
return Environment.ExitCode;
