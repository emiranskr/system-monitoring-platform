using SysMon.Agent;

namespace Agent.Tests;

public class OptionsTests
{
    [Fact]
    public void Parse_varsayilan_konsol_modudur()
    {
        var o = AgentOptions.Parse([]);
        Assert.False(o.ServiceMode);
        Assert.False(o.AllowInsecureLoopback);
    }

    [Fact]
    public void Parse_service_bayragi_servis_modunu_acar()
    {
        Assert.True(AgentOptions.Parse(["--service"]).ServiceMode);
    }

    [Fact]
    public void Https_her_zaman_izinli()
    {
        var o = AgentOptions.Parse([]);
        Assert.True(ServerUrlPolicy.IsAllowed(new Uri("https://monitor.example.com"), o));
    }

    [Fact]
    public void Http_bayraksiz_loopback_dahil_reddedilir()
    {
        var o = AgentOptions.Parse([]);
        Assert.False(ServerUrlPolicy.IsAllowed(new Uri("http://localhost:3000"), o));
    }

#if DEBUG
    [Theory]
    [InlineData("http://localhost:3000")]
    [InlineData("http://127.0.0.1:3000")]
    [InlineData("http://[::1]:3000")]
    public void Debug_bayrakla_loopback_http_izinli(string url)
    {
        var o = AgentOptions.Parse(["--allow-insecure-loopback"]);
        Assert.True(ServerUrlPolicy.IsAllowed(new Uri(url), o));
    }

    [Theory]
    [InlineData("http://example.com")]
    [InlineData("http://192.168.1.10:3000")]
    [InlineData("http://localhost.evil.com")]
    public void Debug_bayrakla_bile_loopback_disi_http_reddedilir(string url)
    {
        var o = AgentOptions.Parse(["--allow-insecure-loopback"]);
        Assert.False(ServerUrlPolicy.IsAllowed(new Uri(url), o));
    }
#else
    [Fact]
    public void Release_derlemesinde_insecure_loopback_bayragi_yok()
    {
        Assert.Throws<ArgumentException>(() => AgentOptions.Parse(["--allow-insecure-loopback"]));
    }
#endif
}
