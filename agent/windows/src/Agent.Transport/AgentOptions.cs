namespace SysMon.Agent;

/// <summary>Komut satiri secenekleri. Varsayilan: konsol modu.</summary>
public sealed record AgentOptions(
    bool ServiceMode,
    bool AllowInsecureLoopback,
    string? Server = null,
    string? TokenFile = null,
    string? DataDir = null)
{
    public static AgentOptions Parse(string[] args)
    {
        var service = false;
        var insecure = false;
        string? server = null, tokenFile = null, dataDir = null;
        for (var i = 0; i < args.Length; i++)
        {
            switch (args[i])
            {
                case "--service":
                    service = true;
                    break;
                case "--server":
                    server = Value(args, ref i);
                    break;
                case "--token-file":
                    tokenFile = Value(args, ref i);
                    break;
                case "--data-dir":
                    dataDir = Value(args, ref i);
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
        return new AgentOptions(service, insecure, server, tokenFile, dataDir);
    }

    private static string Value(string[] args, ref int i)
    {
        if (i + 1 >= args.Length) throw new ArgumentException($"{args[i]} icin deger gerekli.");
        return args[++i];
    }
}
