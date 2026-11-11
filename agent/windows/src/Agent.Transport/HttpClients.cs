using System.Net.Security;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;

namespace SysMon.Agent.Transport;

/// <summary>Sunucu sertifikasinin SubjectPublicKeyInfo SHA-256 parmak izi: "sha256/&lt;base64&gt;".</summary>
public static class SpkiPin
{
    public static string Compute(X509Certificate2 cert) =>
        "sha256/" + Convert.ToBase64String(SHA256.HashData(cert.PublicKey.ExportSubjectPublicKeyInfo()));
}

public static class HttpClients
{
    public const long MaxResponseContentBufferSize = 1_048_576; // 1 MB

    /// <summary>
    /// pins verilmisse: sunucu yaprak sertifikasinin SPKI parmak izi pinlerden biriyle eslesmedikce baglanti
    /// reddedilir (zincir/ad dogrulamasi yerine anahtar sabitleme; kendinden imzali sunucular icin).
    /// Dogrulama basarisizsa TLS el sikismasi bitmeden kesilir; token ve veri gonderilmez.
    /// pins yoksa: yalnizca normal sistem dogrulamasi. Dogrulamayi kapatan bir mod YOKTUR.
    /// O7: Yonlendirme izlenmez (AllowAutoRedirect = false), yanit boyutu 1 MB ile sinirlanir,
    /// baglanti omru 15 dakika ile sinirlanir (DNS guncellemeleri icin).
    /// </summary>
    public static HttpClient Create(IReadOnlyList<string>? pins, TimeSpan? timeout = null)
    {
        var handler = new SocketsHttpHandler
        {
            AllowAutoRedirect = false,
            PooledConnectionLifetime = TimeSpan.FromMinutes(15),
        };
        if (pins is { Count: > 0 })
        {
            var allowed = pins.ToHashSet(StringComparer.Ordinal);
            handler.SslOptions = new SslClientAuthenticationOptions
            {
                RemoteCertificateValidationCallback = (_, cert, _, _) =>
                {
                    if (cert is null) return false;
                    var c2 = cert as X509Certificate2 ?? new X509Certificate2(cert);
                    return allowed.Contains(SpkiPin.Compute(c2));
                },
            };
        }
        return new HttpClient(handler)
        {
            Timeout = timeout ?? TimeSpan.FromSeconds(30),
            MaxResponseContentBufferSize = MaxResponseContentBufferSize,
        };
    }
}
