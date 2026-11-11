using System.Net;

namespace SysMon.Agent;

/// <summary>Sunucu URL'si politikasi: https her zaman; http yalnizca loopback + bayrak.</summary>
public static class ServerUrlPolicy
{
    public static bool IsAllowed(Uri url, AgentOptions options)
    {
        if (url.Scheme == Uri.UriSchemeHttps) return true;
        if (url.Scheme != Uri.UriSchemeHttp) return false;
        if (!options.AllowInsecureLoopback) return false;
        return IsLoopbackHost(url.HostNameType, url.IdnHost);
    }

    private static bool IsLoopbackHost(UriHostNameType type, string host)
    {
        if (type == UriHostNameType.Dns)
            return string.Equals(host, "localhost", StringComparison.OrdinalIgnoreCase);
        return IPAddress.TryParse(host.Trim('[', ']'), out var ip) && IPAddress.IsLoopback(ip);
    }
}
