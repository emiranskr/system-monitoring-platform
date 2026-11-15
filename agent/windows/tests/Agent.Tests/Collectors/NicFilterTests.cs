using System.Net;
using System.Net.NetworkInformation;
using SysMon.Agent.Collectors;

namespace Agent.Tests.Collectors;

/// <summary>
/// M2 bulgusu: .NET (Core) gizli "filtre baglama" arayuzlerini de dondurur (Ethernet-QoS Packet Scheduler-0000, ...WFP...-0000,
/// Wi-Fi Direct sanal adaptorleri): gercek makinede 3 gercek arayuze karsilik ~21 arayuz = cihaz basina ~40 gereksiz seri.
/// Adlar bu makineden GOZLENEN gercek adlardir.
/// </summary>
public class NicFilterTests
{
    private static readonly IPAddress Private4 = IPAddress.Parse("192.168.1.20");
    private static readonly IPAddress LinkLocal4 = IPAddress.Parse("169.254.7.9");
    private static readonly IPAddress LinkLocal6 = IPAddress.Parse("fe80::1234:5678:9abc:def0");
    private static readonly IPAddress Global6 = IPAddress.Parse("2001:db8::10");

    private static NicInfo Nic(string name, string desc = "Adapter", NetworkInterfaceType type = NetworkInterfaceType.Ethernet,
        OperationalStatus status = OperationalStatus.Up, params IPAddress[] addrs) => new(name, desc, type, status, addrs);

    // M-10a: 0.0.0.0 ve :: "adres" sayilmaz (baglanti bilgisi olmayan arayuz).
    [Fact]
    public void Belirtilmemis_adresler_baglanti_sayilmaz()
    {
        Assert.False(NicFilter.IsMonitored(Nic("Ethernet 9", addrs: [IPAddress.Any, IPAddress.IPv6Any])));
        Assert.True(NicFilter.IsMonitored(Nic("Ethernet 9", addrs: [IPAddress.Any, Private4])));
    }

    // M-10b: GetIPProperties() fırlatan tek bir sanal adaptor tum ag kolektorunu dusurmemeli: o arayuz atlanir.
    [Fact]
    public void Arayuz_bilgisi_okunurken_istisna_o_arayuzu_atlar_digerlerini_etkilemez()
    {
        Func<NicInfo> bad = () => throw new NetworkInformationException(1);
        Assert.False(NicFilter.IsMonitored(bad));
        Assert.True(NicFilter.IsMonitored(() => Nic("Ethernet", addrs: Private4)));
    }

    [Theory]
    [InlineData("Ethernet-QoS Packet Scheduler-0000")]
    [InlineData("Ethernet-WFP Native MAC Layer LightWeight Filter-0000")]
    [InlineData("Ethernet-WFP 802.3 MAC Layer LightWeight Filter-0000")]
    [InlineData("vEthernet (WSL (Hyper-V firewall))-WFP Native MAC Layer LightWeight Filter-0000")]
    [InlineData("Yerel Ağ Bağlantısı* 6-QoS Packet Scheduler-0000")]
    [InlineData("Wi-Fi-Virtual WiFi Filter Driver-0001")]
    public void Filtre_baglama_arayuzleri_adres_olsa_bile_izlenmez(string name)
    {
        Assert.False(NicFilter.IsMonitored(Nic(name, addrs: Private4)));
    }

    [Theory]
    [InlineData("Ethernet")]
    [InlineData("Wi-Fi")]
    [InlineData("vEthernet (Default Switch)")]
    [InlineData("vEthernet (WSL (Hyper-V firewall))")]
    [InlineData("Yerel Ağ Bağlantısı")]
    public void Gercek_adresli_acik_arayuz_izlenir(string name)
    {
        Assert.True(NicFilter.IsMonitored(Nic(name, addrs: Private4)));
    }

    [Fact]
    public void Adresi_olmayan_acik_arayuz_izlenmez_Wi_Fi_Direct_sanal_adaptor()
    {
        Assert.False(NicFilter.IsMonitored(Nic("Yerel Ağ Bağlantısı* 6", "Microsoft Wi-Fi Direct Virtual Adapter #2")));
    }

    [Fact]
    public void Yalnizca_link_local_adresli_arayuz_izlenmez_ama_global_IPv6_ile_izlenir()
    {
        Assert.False(NicFilter.IsMonitored(Nic("Yerel Ağ Bağlantısı* 7", addrs: [LinkLocal4, LinkLocal6])));
        Assert.True(NicFilter.IsMonitored(Nic("Ethernet", addrs: [LinkLocal6, Global6])));
    }

    [Theory]
    [InlineData(NetworkInterfaceType.Loopback)]
    [InlineData(NetworkInterfaceType.Tunnel)]
    public void Loopback_ve_tunel_izlenmez(NetworkInterfaceType t)
    {
        Assert.False(NicFilter.IsMonitored(Nic("Loopback Pseudo-Interface 1", type: t, addrs: IPAddress.Loopback)));
    }

    [Theory]
    [InlineData(OperationalStatus.Down)]
    [InlineData(OperationalStatus.Dormant)]
    [InlineData(OperationalStatus.NotPresent)]
    public void Kapali_arayuz_izlenmez(OperationalStatus s)
    {
        Assert.False(NicFilter.IsMonitored(Nic("Ethernet", status: s, addrs: Private4)));
    }

    [Fact]
    public void Gercek_makinede_filtre_baglama_arayuzu_yok_ve_fiziksel_arayuz_var()
    {
        if (!OperatingSystem.IsWindows()) return;
        var nics = new SystemNetworkSource().Read();

        Assert.NotEmpty(nics);                                                         // ag baglantisi olan makinede en az bir arayuz
        Assert.DoesNotContain(nics, n => System.Text.RegularExpressions.Regex.IsMatch(n.Id, @"-\d{4}$")); // filtre ornegi yok
        Assert.DoesNotContain(nics, n => n.Id.Contains("QoS Packet Scheduler", StringComparison.OrdinalIgnoreCase));
        Assert.DoesNotContain(nics, n => n.Id.Contains("WFP", StringComparison.OrdinalIgnoreCase));
        Assert.True(nics.Count <= 8, $"beklenmedik cok arayuz ({nics.Count}): {string.Join(", ", nics.Select(n => n.Id))}");
    }
}
