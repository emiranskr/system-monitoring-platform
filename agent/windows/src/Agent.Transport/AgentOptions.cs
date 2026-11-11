namespace SysMon.Agent;

/// <summary>Komut satiri secenekleri. Varsayilan: konsol modu.</summary>
public sealed record AgentOptions(bool ServiceMode, bool AllowInsecureLoopback)
{
    public static AgentOptions Parse(string[] args)
    {
        var service = false;
        var insecure = false;
        foreach (var a in args)
        {
            switch (a)
            {
                case "--service":
                    service = true;
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
                    throw new ArgumentException($"Bilinmeyen secenek: {a}");
            }
        }
        return new AgentOptions(service, insecure);
    }
}
