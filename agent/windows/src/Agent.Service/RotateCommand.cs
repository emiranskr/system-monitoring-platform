using System.Runtime.Versioning;
using SysMon.Agent.Transport;

namespace SysMon.Agent;

/// <summary>
/// `--rotate --server https://...`: mevcut cihaz kimlik bilgisini yenisiyle degistirir (korumali depoya yazar). rotation_id veri dizininde saklanir,
/// boylece yanit kaybolursa ayni komut ayni yeni kimlik bilgisini geri alir. Cikis kodlari: 0 basarili, 2 girdi/depo hatasi, 3 kimlik reddedildi,
/// 4 hiz siniri, 5 gecici hata (yeniden deneyin), 6 TLS dogrulamasi basarisiz, 7 diger/cakisma.
/// Servis calisirken calistirilabilir: sunucu 24 saat eski ve yeni kimlik bilgisini birlikte kabul eder; servis yeniden baslatilinca yeni kimlik bilgisini okur.
/// </summary>
[SupportedOSPlatform("windows")]
public static class RotateCommand
{
    public static async Task<int> RunAsync(AgentOptions o, TextWriter output, TextWriter error, CancellationToken ct = default)
    {
        var server = new Uri(o.Server!);
        if (!ServerUrlPolicy.IsAllowed(server, o)) { error.WriteLine("--server adresine izin verilmiyor: https gerekir."); return 2; }
        var store = new TokenStore(AgentPaths.TokenStorePath(o), o.TokenReader is null ? null : [o.TokenReader]);
        if (!store.TryLoad(out var current) || string.IsNullOrEmpty(current)) { error.WriteLine("Korumali kimlik bilgisi bulunamadi/okunamadi; once --enroll ile kaydolun."); return 2; }

        var dataDir = AgentPaths.DataDir(o);
        Directory.CreateDirectory(dataDir);
        var idFile = Path.Combine(dataDir, "rotation-id");
        var rotationId = File.Exists(idFile) && Guid.TryParse(File.ReadAllText(idFile).Trim(), out var saved) ? saved : Guid.NewGuid();
        File.WriteAllText(idFile, rotationId.ToString());

        using var http = HttpClients.Create(o.ServerPins);
        var r = await Rotator.RotateAsync(http, server, current, rotationId, ct).ConfigureAwait(false);
        switch (r.Outcome)
        {
            case RotateOutcome.Rotated:
                store.Save(r.Credential!);
                if (!store.TryLoad(out var check) || check != r.Credential) { error.WriteLine("Yeni kimlik bilgisi yazildi ama dogrulanamadi; komutu yeniden calistirin."); return 5; }
                try { File.Delete(idFile); } catch (Exception e) when (e is IOException or UnauthorizedAccessException) { /* donme tamam */ }
                output.WriteLine($"Kimlik bilgisi donduruldu. Eski kimlik bilgisi {r.OverlapExpiresAt:u} tarihine kadar gecerli; yeni kimlik bilgisi ilk kullanildiginda eskisi iptal olur.");
                return 0;
            case RotateOutcome.Rejected: error.WriteLine("Kimlik bilgisi reddedildi (iptal edilmis veya gecersiz)."); return 3;
            case RotateOutcome.RateLimited: error.WriteLine("Cok fazla deneme (hiz siniri)."); return 4;
            case RotateOutcome.TlsRejected: error.WriteLine("TLS dogrulamasi basarisiz (sertifika/pin). Kimlik bilgisi GONDERILMEDI."); return 6;
            case RotateOutcome.Conflict or RotateOutcome.ClientError: error.WriteLine("Sunucu istegi reddetti (bekleyen baska bir dondurme olabilir)."); return 7;
            default: error.WriteLine("Sunucuya ulasilamadi veya gecici sunucu hatasi. Ayni komutu yeniden calistirin."); return 5;
        }
    }
}
