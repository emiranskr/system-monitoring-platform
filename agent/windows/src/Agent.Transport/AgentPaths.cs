namespace SysMon.Agent;

/// <summary>Veri dizini ve korumali token yolu cozumlemesi (tek kaynak).</summary>
public static class AgentPaths
{
    public static string DataDir(AgentOptions o) =>
        o.DataDir ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "SysMon", "agent");

    public static string SpoolDir(AgentOptions o) => Path.Combine(DataDir(o), "spool");

    /// <summary>--token-file verilmisse o yol, yoksa veri dizinindeki identity/token.bin.</summary>
    public static string TokenStorePath(AgentOptions o) =>
        o.TokenFile ?? Path.Combine(DataDir(o), "identity", "token.bin");
}
