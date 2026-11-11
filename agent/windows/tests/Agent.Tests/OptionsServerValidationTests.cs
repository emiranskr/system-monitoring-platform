using SysMon.Agent;

namespace Agent.Tests;

public class OptionsServerValidationTests
{
    [Theory]
    [InlineData("https://kullanici:parola@monitor.example.com")]
    [InlineData("ftp://monitor.example.com")]
    [InlineData("bu bir url degil")]
    [InlineData("/goreli/yol")]
    public void Server_userinfo_icerirse_gecersizse_veya_http_https_degilse_reddedilir(string url)
    {
        Assert.Throws<ArgumentException>(() => AgentOptions.Parse(["--server", url]));
    }

    [Theory]
    [InlineData("https://monitor.example.com")]
    [InlineData("https://monitor.example.com:8443/")]
    public void Gecerli_https_sunucu_kabul_edilir(string url)
    {
        Assert.Equal(url, AgentOptions.Parse(["--server", url]).Server);
    }

    [Theory]
    [InlineData("sha256/AAAA")]
    [InlineData("md5/x")]
    [InlineData("")]
    public void Gecersiz_pin_bicimi_reddedilir(string pin)
    {
        Assert.Throws<ArgumentException>(() => AgentOptions.Parse(["--server-pin", pin]));
    }

    [Fact]
    public void Gecerli_pin_kabul_edilir()
    {
        var pin = "sha256/" + Convert.ToBase64String(new byte[32]);
        Assert.Equal(pin, AgentOptions.Parse(["--server-pin", pin]).ServerPins![0]);
    }
}
