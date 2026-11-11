using System.Collections.Concurrent;
using System.IO.Compression;
using System.Net;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text.Json;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Logging;

namespace Agent.Tests.Transport;

/// <summary>Gercek Kestrel HTTPS sunucusu, kendinden imzali ECDSA sertifikayla. Durdurulup ayni portta yeniden baslatilabilir.</summary>
public sealed class TestHttpsServer : IAsyncDisposable
{
    public int Port { get; }
    public X509Certificate2 Cert { get; }
    public Uri Url => new($"https://127.0.0.1:{Port}/");
    public ConcurrentQueue<JsonElement> Bodies { get; } = new();
    public ConcurrentQueue<string?> AuthHeaders { get; } = new();
    public Func<JsonElement, (int Status, string Json)>? Respond { get; set; }

    private WebApplication? _app;

    public TestHttpsServer()
    {
        var l = new TcpListener(IPAddress.Loopback, 0);
        l.Start();
        Port = ((IPEndPoint)l.LocalEndpoint).Port;
        l.Stop();
        Cert = CreateCert();
    }

    private static X509Certificate2 CreateCert()
    {
        using var key = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var req = new CertificateRequest("CN=sysmon-test", key, HashAlgorithmName.SHA256);
        var san = new SubjectAlternativeNameBuilder();
        san.AddIpAddress(IPAddress.Loopback);
        req.CertificateExtensions.Add(san.Build());
        using var cert = req.CreateSelfSigned(DateTimeOffset.UtcNow.AddMinutes(-5), DateTimeOffset.UtcNow.AddDays(1));
        return X509CertificateLoader.LoadPkcs12(cert.Export(X509ContentType.Pfx), null);
    }

    public async Task StartAsync()
    {
        var builder = WebApplication.CreateSlimBuilder();
        builder.Logging.ClearProviders();
        builder.WebHost.ConfigureKestrel(k => k.Listen(IPAddress.Loopback, Port, o => o.UseHttps(Cert)));
        var app = builder.Build();
        app.MapPost("/agent/v1/ingest", async (HttpContext ctx) =>
        {
            Stream input = ctx.Request.Body;
            if (ctx.Request.Headers.ContentEncoding == "gzip") input = new GZipStream(input, CompressionMode.Decompress);
            using var ms = new MemoryStream();
            await input.CopyToAsync(ms);
            var body = JsonDocument.Parse(ms.ToArray()).RootElement.Clone();
            Bodies.Enqueue(body);
            AuthHeaders.Enqueue(ctx.Request.Headers.Authorization);

            var (status, json) = Respond?.Invoke(body)
                ?? (200, JsonSerializer.Serialize(new
                {
                    ack_seq = body.GetProperty("seq").GetInt64(),
                    rejected = 0,
                    server_time = DateTimeOffset.UtcNow.ToString("O"),
                }));
            ctx.Response.StatusCode = status;
            ctx.Response.ContentType = "application/json";
            await ctx.Response.WriteAsync(json);
        });
        await app.StartAsync();
        _app = app;
    }

    public async Task StopAsync()
    {
        if (_app is null) return;
        await _app.StopAsync();
        await _app.DisposeAsync();
        _app = null;
    }

    public async ValueTask DisposeAsync()
    {
        await StopAsync();
        Cert.Dispose();
    }
}
