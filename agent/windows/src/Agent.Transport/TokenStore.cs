using System.Runtime.Versioning;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;

namespace SysMon.Agent.Transport;

/// <summary>
/// Cihaz token'ini diskte DPAPI (LocalMachine) ile sifrelenmis olarak, miras kapali kisitli ACL ile
/// ve atomik degistirme ile saklar. LocalMachine kapsami: token'i iceri aktaran yonetici hesabi ile
/// servisi calistiran sanal hesap farkli oldugundan CurrentUser kapsami kullanilamaz.
/// Durust sinir: SYSTEM veya yonetici yetkisine sahip bir saldirgan token'i yine okuyabilir;
/// koruma baska kullanicilara ve diske duz metin yazilmasina karsidir (bkz. proposal.md Bolum 10.3).
/// </summary>
[SupportedOSPlatform("windows")]
public sealed class TokenStore(string path, IReadOnlyList<string>? extraAccounts = null)
{
    // Uygulamaya ozgu entropi: ayni makinede baska uygulamalarin blobunu cozmesini zorlastirir.
    private static readonly byte[] Entropy = "SysMon.Agent.TokenStore.v1"u8.ToArray();
    private static readonly byte[] Magic = "SMT1"u8.ToArray();

    public string Path { get; } = path;

    public void Save(string token)
    {
        if (string.IsNullOrWhiteSpace(token)) throw new ArgumentException("Token bos olamaz.", nameof(token));

        // Hesap adlari dosya olusturulmadan once cozumlenir: bilinmeyen hesap yarim kalmis dosya birakmaz.
        var extra = ResolveAccounts(extraAccounts);

        var dir = System.IO.Path.GetDirectoryName(Path)!;
        Directory.CreateDirectory(dir);

        var blob = ProtectedData.Protect(Encoding.UTF8.GetBytes(token), Entropy, DataProtectionScope.LocalMachine);
        var payload = new byte[Magic.Length + blob.Length];
        Magic.CopyTo(payload, 0);
        blob.CopyTo(payload, Magic.Length);

        var tmp = Path + "." + Guid.NewGuid().ToString("N") + ".tmp";
        try
        {
            // Dosya, ACL kisitlanmadan once hic icerik tasimaz: bos olustur, ACL uygula, sonra yaz.
            using (var fs = new FileStream(tmp, FileMode.CreateNew, FileAccess.ReadWrite, FileShare.None))
            {
                RestrictAcl(new FileInfo(tmp), extra);
                fs.Write(payload);
                fs.Flush(true);
            }
            ReplaceWithRetry(tmp, Path);
        }
        finally
        {
            try { if (File.Exists(tmp)) File.Delete(tmp); } catch (IOException) { /* sonraki Save temizler */ }
        }
    }

    /// <summary>Eksik veya bozuksa false. Degistirme sirasindaki gecici paylasim ihlallerinde kisa sure yeniden dener.</summary>
    public bool TryLoad(out string? token)
    {
        token = null;
        for (var attempt = 0; attempt < 8; attempt++)
        {
            try
            {
                if (!File.Exists(Path)) return false;
                // FileShare.Delete: yazicinin atomik Move(overwrite) islemi okuyucu aciksa da basarili olur.
                byte[] payload;
                using (var fs = new FileStream(Path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
                using (var ms = new MemoryStream())
                {
                    fs.CopyTo(ms);
                    payload = ms.ToArray();
                }
                if (payload.Length <= Magic.Length || !payload.AsSpan(0, Magic.Length).SequenceEqual(Magic)) return false;
                var plain = ProtectedData.Unprotect(payload[Magic.Length..], Entropy, DataProtectionScope.LocalMachine);
                token = Encoding.UTF8.GetString(plain);
                return token.Length > 0;
            }
            catch (CryptographicException)
            {
                return false; // bozuk veya baska makineye ait blob
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                // Yazici dosyayi o an degistiriyor olabilir; kisa bekleyip yeniden dene, sonunda false don.
                Thread.Sleep(5 * (attempt + 1));
            }
        }
        return false;
    }

    /// <summary>
    /// Ayni birimde atomik degistirme (MoveFileEx REPLACE_EXISTING): okuyucu eski veya yeni icerigi gorur.
    /// Hedef o an okuyucu tarafindan aciksa Windows gecici olarak erisim reddi/paylasim ihlali verir;
    /// okuyucu tutamaclari kisa omurlu oldugundan sinirli sure yeniden denenir, sonunda hata yuzeye cikar.
    /// </summary>
    private static void ReplaceWithRetry(string source, string dest)
    {
        for (var attempt = 0; ; attempt++)
        {
            try
            {
                File.Move(source, dest, overwrite: true);
                return;
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException && attempt < 100)
            {
                Thread.Sleep(10);
            }
        }
    }

    private static List<SecurityIdentifier> ResolveAccounts(IReadOnlyList<string>? accounts)
    {
        var result = new List<SecurityIdentifier>();
        foreach (var a in accounts ?? [])
        {
            try
            {
                result.Add(a.StartsWith("S-1-", StringComparison.Ordinal)
                    ? new SecurityIdentifier(a)
                    : (SecurityIdentifier)new NTAccount(a).Translate(typeof(SecurityIdentifier)));
            }
            catch (Exception ex) when (ex is IdentityNotMappedException or ArgumentException or SystemException)
            {
                throw new ArgumentException($"Hesap cozumlenemedi: {a}", nameof(accounts), ex);
            }
        }
        return result;
    }

    /// <summary>
    /// Token dosyasina erisebilecek ana hesaplar: SYSTEM + Administrators her zaman. Ek hesap (servis) verilmediyse
    /// token'i yazan hesap (gelistirici/servisin kendisi) eklenir. Ek hesap verilmisse kurulumu yapan yoneticinin
    /// kisisel hesabi ACL'e GIRMEZ: token servis icindir, yonetici zaten Administrators uyesidir.
    /// </summary>
    public static IReadOnlyList<SecurityIdentifier> AclPrincipals(IReadOnlyList<SecurityIdentifier> extra, SecurityIdentifier? current)
    {
        var list = new List<SecurityIdentifier>
        {
            new(WellKnownSidType.LocalSystemSid, null),
            new(WellKnownSidType.BuiltinAdministratorsSid, null),
        };
        if (extra.Count == 0 && current is not null) list.Add(current);
        list.AddRange(extra);
        return list.Distinct().ToList();
    }

    private static void RestrictAcl(FileInfo file, IReadOnlyList<SecurityIdentifier> extra)
    {
        var security = new FileSecurity();
        security.SetAccessRuleProtection(isProtected: true, preserveInheritance: false);
        foreach (var sid in AclPrincipals(extra, WindowsIdentity.GetCurrent().User))
        {
            // SYSTEM ve Administrators tam yetki; digerleri (servis hesabi) yalniz okuma/yazma/silme (Modify): ACL degistiremez, sahiplik alamaz.
            var full = sid.IsWellKnown(WellKnownSidType.LocalSystemSid) || sid.IsWellKnown(WellKnownSidType.BuiltinAdministratorsSid);
            security.AddAccessRule(new FileSystemAccessRule(sid, full ? FileSystemRights.FullControl : FileSystemRights.Modify, AccessControlType.Allow));
        }
        file.SetAccessControl(security);
    }
}

/// <summary>Duz metin bootstrap dosyasindaki token'i korumali depoya tasir ve duz metin dosyayi siler.</summary>
[SupportedOSPlatform("windows")]
public static class TokenImporter
{
    public static void Import(string plainTextPath, TokenStore store)
    {
        var token = File.ReadAllText(plainTextPath).Trim();
        if (token.Length == 0) throw new ArgumentException("Bootstrap token dosyasi bos.", nameof(plainTextPath));

        store.Save(token);
        if (!store.TryLoad(out var check) || check != token)
            throw new InvalidOperationException("Korumali depoya yazilan token dogrulanamadi; duz metin dosya silinmedi.");

        // Silmeden once uzerine yaz (SSD/yedekleme garantisi vermez; yalnizca en iyi cabadir).
        var len = new FileInfo(plainTextPath).Length;
        File.WriteAllBytes(plainTextPath, new byte[len]);
        File.Delete(plainTextPath);
    }
}
