namespace SysMon.Agent;

/// <summary>Komut satiri secenekleri. Varsayilan: konsol modu.</summary>
public sealed record AgentOptions(
    bool ServiceMode,
    bool AllowInsecureLoopback,
    string? Server = null,
    string? TokenFile = null,
    string? DataDir = null,
    string? ImportToken = null,
    IReadOnlyList<string>? ServerPins = null,
    string? TokenReader = null,
    string? EnrollTokenFile = null,
    bool Rotate = false)
{
    public static AgentOptions Parse(string[] args)
    {
        var service = false;
        var insecure = false;
        var rotate = false;
        string? server = null, tokenFile = null, dataDir = null, importToken = null, tokenReader = null, enroll = null;
        var pins = new List<string>();
        for (var i = 0; i < args.Length; i++)
        {
            switch (args[i])
            {
                case "--service":
                    service = true;
                    break;
                case "--server":
                    server = ValidateServerUrl(Value(args, ref i));
                    break;
                case "--token-file":
                    tokenFile = Value(args, ref i);
                    break;
                case "--data-dir":
                    dataDir = Value(args, ref i);
                    break;
                case "--import-token":
                    importToken = Value(args, ref i);
                    break;
                case "--rotate":
                    rotate = true;
                    break;
                case "--enroll":
                    enroll = Value(args, ref i);   // kayit belirecinin bulundugu DOSYA (komut satirinda belirec gecmez: surec listesinde gorunurdu)
                    break;
                case "--token-reader":
                    tokenReader = Value(args, ref i);
                    break;
                case "--server-pin":
                    pins.Add(ValidateServerPin(Value(args, ref i)));
                    break;
                case "--allow-insecure-loopback":
#if DEBUG
                    insecure = true;
                    break;
#else
                    throw new ArgumentException(
                        "--allow-insecure-loopback Release derlemelerinde desteklenmez.");
#endif
                default:
                    throw new ArgumentException($"Bilinmeyen secenek: {args[i]}");
            }
        }
        if (enroll is not null && server is null) throw new ArgumentException("--enroll icin --server gerekli.");
        if (enroll is not null && importToken is not null) throw new ArgumentException("--enroll ile --import-token birlikte kullanilamaz.");
        if (rotate && server is null) throw new ArgumentException("--rotate icin --server gerekli.");
        if (rotate && (enroll is not null || importToken is not null)) throw new ArgumentException("--rotate, --enroll/--import-token ile birlikte kullanilamaz.");
        return new AgentOptions(service, insecure, server, tokenFile, dataDir, importToken, pins.Count == 0 ? null : pins, tokenReader, enroll, rotate);
    }

    private static string Value(string[] args, ref int i)
    {
        if (i + 1 >= args.Length) throw new ArgumentException($"{args[i]} icin deger gerekli.");
        return args[++i];
    }

    private static string ValidateServerUrl(string url)
    {
        if (!Uri.TryCreate(url, UriKind.Absolute, out var uri))
            throw new ArgumentException($"Gecersiz sunucu adresi (mutlak URL gerekli): {url}");

        if (uri.Scheme != Uri.UriSchemeHttps && uri.Scheme != Uri.UriSchemeHttp)
            throw new ArgumentException($"Sunucu adresi yalnizca http veya https olabilir: {url}");

        if (!string.IsNullOrEmpty(uri.UserInfo))
            throw new ArgumentException($"Sunucu adresi kullanici bilgisi (userinfo) iceremez: {url}");

        return url;
    }

    private static string ValidateServerPin(string pin)
    {
        const string prefix = "sha256/";
        if (!pin.StartsWith(prefix, StringComparison.Ordinal))
            throw new ArgumentException($"Sunucu pin'i 'sha256/' ile baslamalidir: {pin}");

        var b64 = pin[prefix.Length..];
        Span<byte> buffer = stackalloc byte[32];
        if (!Convert.TryFromBase64String(b64, buffer, out var bytesWritten) || bytesWritten != 32)
            throw new ArgumentException($"Sunucu pin'i 32 baytlik gecerli bir Base64 SHA-256 degeri olmalidir: {pin}");

        return pin;
    }
}
