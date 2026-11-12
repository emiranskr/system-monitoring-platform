using System.Net;
using System.Net.NetworkInformation;
using System.Text.RegularExpressions;

namespace SysMon.Agent.Collectors;

/// <summary>Filtre kurali icin bir ag arayuzunun ozeti (saf veri: platformdan bagimsiz test edilebilir).</summary>
public sealed record NicInfo(string Name, string Description, NetworkInterfaceType Type, OperationalStatus Status, IReadOnlyList<IPAddress> Addresses);

/// <summary>
/// Hangi ag arayuzlerinin izlenecegini belirler. .NET (Core) Windows'ta gizli "filtre baglama" arayuzlerini de dondurur
/// (ornegin "Ethernet-QoS Packet Scheduler-0000", "...WFP Native MAC Layer LightWeight Filter-0000") ve adresi olmayan
/// Wi-Fi Direct sanal adaptorlerini: gercek makinede 3 gercek arayuze karsilik ~21 arayuz, yani cihaz basina ~40 gereksiz seri
/// (depolama hacmi; docs/ilerleme/M2.md). Izlenen arayuz: acik, loopback/tunel degil, filtre ornegi degil ve en az bir
/// link-local OLMAYAN adresi var (baglanti bilgisi olan arayuz).
/// </summary>
public static partial class NicFilter
{
    // Filtre baglama ornekleri adin sonuna 4 haneli bir sayi ekler: "...-0000", "...-0001".
    [GeneratedRegex(@"-\d{4}$")]
    private static partial Regex FilterInstanceSuffix();

    public static bool IsMonitored(NicInfo n)
    {
        if (n.Status != OperationalStatus.Up) return false;
        if (n.Type is NetworkInterfaceType.Loopback or NetworkInterfaceType.Tunnel) return false;
        if (FilterInstanceSuffix().IsMatch(n.Name)) return false;
        return n.Addresses.Any(a => !IsLinkLocal(a) && !IPAddress.IsLoopback(a));
    }

    private static bool IsLinkLocal(IPAddress a)
    {
        if (a.IsIPv6LinkLocal) return true;
        var b = a.GetAddressBytes();
        return b.Length == 4 && b[0] == 169 && b[1] == 254; // APIPA 169.254.0.0/16
    }
}
