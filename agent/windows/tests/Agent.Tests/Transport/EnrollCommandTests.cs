#if DEBUG
using System.Net;
using SysMon.Agent;

namespace Agent.Tests.Transport;

/// <summary>
/// EnrollCommand uctan uca (GERCEK HttpListener + Windows kayit defteri/DPAPI; yonetici gerekmez). Release'te http reddedildiginden yalniz Debug'da calisir.
/// </summary>
public sealed class EnrollCommandTests : IDisposable
{
    private readonly string _dir = Path.Combine(Path.GetTempPath(), "sysmon-enrollcmd-" + Guid.NewGuid().ToString("N"));
    public void Dispose() { if (Directory.Exists(_dir)) Directory.Delete(_dir, true); }

    private static (HttpListener L, string Url) Listen(Func<HttpListenerRequest, (int Status, string Body)> handler)
    {
        var port = new Random().Next(20000, 40000);
        for (; ; port++)
        {
            var l = new HttpListener();
            l.Prefixes.Add($"http://127.0.0.1:{port}/");
            try { l.Start(); }
            catch (HttpListenerException) { continue; }
            _ = Task.Run(async () =>
            {
                while (l.IsListening)
                {
                    HttpListenerContext c;
                    try { c = await l.GetContextAsync(); } catch { return; }
                    var (status, body) = handler(c.Request);
                    c.Response.StatusCode = status;
                    var bytes = System.Text.Encoding.UTF8.GetBytes(body);
                    c.Response.ContentType = "application/json";
                    await c.Response.OutputStream.WriteAsync(bytes);
                    c.Response.Close();
                }
            });
            return (l, $"http://127.0.0.1:{port}");
        }
    }

    private AgentOptions Options(string url, string tokenFile) =>
        new(false, true, Server: url, DataDir: Path.Combine(_dir, "veri"), EnrollTokenFile: tokenFile, TokenReader: System.Security.Principal.WindowsIdentity.GetCurrent().User!.Value);

    [Fact]
    public async Task Reddedilen_kayit_BAYAT_enroll_id_dosyasini_siler_yeni_belirecle_yeniden_denenebilsin()
    {
        var (l, url) = Listen(_ => (401, "{}"));
        try
        {
            Directory.CreateDirectory(Path.Combine(_dir, "veri"));
            var idFile = Path.Combine(_dir, "veri", "enroll-id");
            File.WriteAllText(idFile, Guid.NewGuid().ToString());
            var tokenFile = Path.Combine(_dir, "kayit.txt");
            File.WriteAllText(tokenFile, "kayit-belirteci-0123456789abcdef0123456789abcdef");
            var rc = await EnrollCommand.RunAsync(Options(url, tokenFile), new StringWriter(), new StringWriter());
            Assert.Equal(3, rc);
            Assert.False(File.Exists(idFile), "bayat enroll-id silinmeli");
            Assert.True(File.Exists(tokenFile), "reddedilen belirec dosyasi silinmez (kullanici duzeltip yeniden deneyebilir)");
        }
        finally { l.Stop(); }
    }

    [Fact]
    public async Task Gecici_hatada_enroll_id_KORUNUR_ve_ayni_kimlikle_yeniden_denenir()
    {
        var seen = new List<string>();
        var (l, url) = Listen(r => { using var s = new StreamReader(r.InputStream); seen.Add(s.ReadToEnd()); return (503, "{}"); });
        try
        {
            var tokenFile = Path.Combine(_dir, "kayit.txt");
            Directory.CreateDirectory(_dir);
            File.WriteAllText(tokenFile, "kayit-belirteci-0123456789abcdef0123456789abcdef");
            var o = Options(url, tokenFile);
            Assert.Equal(5, await EnrollCommand.RunAsync(o, new StringWriter(), new StringWriter()));
            Assert.Equal(5, await EnrollCommand.RunAsync(o, new StringWriter(), new StringWriter()));
            Assert.Equal(2, seen.Count);
            string Id(string json) => System.Text.Json.JsonDocument.Parse(json).RootElement.GetProperty("enroll_id").GetString()!;
            Assert.Equal(Id(seen[0]), Id(seen[1]));                                   // idempotent yeniden deneme: AYNI enroll_id
        }
        finally { l.Stop(); }
    }
}
#endif
