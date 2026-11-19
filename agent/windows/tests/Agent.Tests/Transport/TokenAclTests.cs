using System.Security.AccessControl;
using System.Security.Principal;
using SysMon.Agent.Transport;

namespace Agent.Tests.Transport;

/// <summary>
/// ACL kurali saf fonksiyon olarak sinanir: ek hesap verilince dosya, testi calistiran (yukseltilmemis)
/// kullanici icin okunamaz hale gelir; bu kasitli bir sonuctur ve dosya uzerinden dogrulamayi imkansiz kilar.
/// </summary>
public sealed class TokenAclTests : IDisposable
{
    private static readonly SecurityIdentifier System_ = new(WellKnownSidType.LocalSystemSid, null);
    private static readonly SecurityIdentifier Admins = new(WellKnownSidType.BuiltinAdministratorsSid, null);
    private static readonly SecurityIdentifier Service = new("S-1-5-80-1234567890-1-2-3-4");
    private static readonly SecurityIdentifier Me = new("S-1-5-21-111-222-333-1001");

    private readonly string _dir = Path.Combine(Path.GetTempPath(), "sysmon-acl-" + Guid.NewGuid().ToString("N"));

    public void Dispose()
    {
        if (Directory.Exists(_dir)) Directory.Delete(_dir, true);
    }

    [Fact]
    public void Ek_hesap_yokken_SYSTEM_Administrators_ve_yazan_hesap()
    {
        var p = TokenStore.AclPrincipals([], Me);
        Assert.Equivalent(new[] { System_, Admins, Me }, p);
    }

    [Fact]
    public void Ek_hesap_verilince_kurulumu_yapan_kisisel_hesap_ACLe_girmez()
    {
        var p = TokenStore.AclPrincipals([Service], Me);
        Assert.Equivalent(new[] { System_, Admins, Service }, p);
        Assert.DoesNotContain(Me, p);
    }

    [Fact]
    public void Ayni_hesap_tekrar_verilirse_yinelenen_girdi_olusmaz()
    {
        var p = TokenStore.AclPrincipals([Service, Service], Me);
        Assert.Equal(p.Count, p.Distinct().Count());
    }

    [Fact]
    public void Yeniden_yazarken_mevcut_dosyanin_servis_hesabi_ACLden_DUSMEZ_rotate_ve_enroll_servisi_kilitlemesin()
    {
        if (!OperatingSystem.IsWindows()) return;
        // Servis hesabi yerine BUILTINUsers (testi calistiran kullanici uyedir): ilk yazma servis hesabini verir, ikinci yazma (--rotate/--enroll,
        // --token-reader OLMADAN) bu hesabi KAYBETMEMELI; aksi halde servis yeni kimlik bilgisini okuyamaz ve cihaz kilitlenir.
        var users = new SecurityIdentifier(WellKnownSidType.BuiltinUsersSid, null);
        var path = Path.Combine(_dir, "identity", "token.bin");
        new TokenStore(path, [users.Value]).Save("ilk_kimlik_bilgisi_0123456789abcdefghij");
        new TokenStore(path).Save("yeni_kimlik_bilgisi_0123456789abcdefghij");           // okuyucu hesap verilmedi

        var rules = new FileInfo(path).GetAccessControl().GetAccessRules(true, true, typeof(SecurityIdentifier)).Cast<FileSystemAccessRule>()
            .Where(r => r.AccessControlType == AccessControlType.Allow).ToList();
        Assert.Contains(rules, r => r.IdentityReference.Equals(users) && r.FileSystemRights.HasFlag(FileSystemRights.Modify));
        Assert.DoesNotContain(rules, r => r.IdentityReference.Equals(new SecurityIdentifier(WellKnownSidType.WorldSid, null)));   // Everyone'a ASLA acilmaz
        Assert.True(new TokenStore(path).TryLoad(out var t) && t == "yeni_kimlik_bilgisi_0123456789abcdefghij");
    }

    [Fact]
    public void Ek_hesap_dosya_ACLinde_Modify_yetkisiyle_bulunur_ve_genis_gruplar_yoktur()
    {
        if (!OperatingSystem.IsWindows()) return;
        // Okunabilir kalmasi icin ek hesap olarak testi calistiran kullanicinin kendi SID'i verilir.
        var me = WindowsIdentity.GetCurrent().User!.Value;
        var path = Path.Combine(_dir, "identity", "token.bin");
        new TokenStore(path, [me]).Save("tok_acl_testi_0123456789abcdefghij");

        var rules = new FileInfo(path).GetAccessControl()
            .GetAccessRules(true, true, typeof(SecurityIdentifier))
            .Cast<FileSystemAccessRule>()
            .Where(r => r.AccessControlType == AccessControlType.Allow)
            .ToList();
        var mine = rules.Single(r => ((SecurityIdentifier)r.IdentityReference).Value == me);
        Assert.True(mine.FileSystemRights.HasFlag(FileSystemRights.Modify));
        Assert.DoesNotContain(rules, r => ((SecurityIdentifier)r.IdentityReference).Value is "S-1-1-0" or "S-1-5-32-545" or "S-1-5-11");
    }
}
