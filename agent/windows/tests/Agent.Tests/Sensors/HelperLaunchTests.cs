using System.Diagnostics;
using System.Security.AccessControl;
using System.Security.Principal;
using SysMon.Agent.Sensors;

namespace Agent.Tests.Sensors;

public class HelperArgsTests
{
    private const string Pipe = "sysmon-sensors-0123456789abcdef0123456789abcdef";
    private const string Sid = "S-1-5-21-1-2-3-1001";

    [Fact]
    public void Gecerli_argumanlar_ayristirilir()
    {
        Assert.True(HelperArgs.TryParse(["--pipe", Pipe, "--parent-pid", "1234", "--allow-sid", Sid], out var a));
        Assert.Equal(Pipe, a!.PipeName);
        Assert.Equal(1234, a.ParentPid);
        Assert.Equal(new SecurityIdentifier(Sid), a.AllowedSid);
    }

    [Theory]
    [InlineData("--pipe", "sysmon-sensors-XYZ")]                                   // bicim
    [InlineData("--pipe", "..\\..\\evil")]                                         // yol gezintisi
    [InlineData("--pipe", "sysmon-sensors-0123456789abcdef0123456789abcdef0")]     // uzun
    [InlineData("--parent-pid", "0")]
    [InlineData("--parent-pid", "-5")]
    [InlineData("--parent-pid", "abc")]
    [InlineData("--allow-sid", "Everyone")]
    [InlineData("--allow-sid", "S-1-bozuk")]
    public void Gecersiz_deger_reddedilir(string key, string bad)
    {
        var args = new Dictionary<string, string> { ["--pipe"] = Pipe, ["--parent-pid"] = "1234", ["--allow-sid"] = Sid };
        args[key] = bad;
        Assert.False(HelperArgs.TryParse(args.SelectMany(kv => new[] { kv.Key, kv.Value }).ToArray(), out _));
    }

    [Fact]
    public void Eksik_fazla_bilinmeyen_ve_tekrarlanan_argumanlar_reddedilir()
    {
        Assert.False(HelperArgs.TryParse([], out _));
        Assert.False(HelperArgs.TryParse(["--pipe", Pipe, "--parent-pid", "1"], out _));                                        // eksik
        Assert.False(HelperArgs.TryParse(["--pipe", Pipe, "--parent-pid", "1", "--allow-sid", Sid, "--extra", "x"], out _));    // bilinmeyen
        Assert.False(HelperArgs.TryParse(["--pipe", Pipe, "--pipe", Pipe, "--parent-pid", "1", "--allow-sid", Sid], out _));    // tekrar
        Assert.False(HelperArgs.TryParse(["--pipe", Pipe, "--parent-pid", "1", "--allow-sid"], out _));                         // deger yok
        Assert.False(HelperArgs.TryParse(["--pipe", Pipe, "--parent-pid", "1", "--allow-sid", Sid, "tek"], out _));             // pozisyonel
    }
}

public class HelperExeValidatorTests
{
    [Fact]
    public void Yonetici_haklariyla_korunan_sistem_exe_si_guvenli_izinlerle_gecer()
    {
        var cmd = Path.Combine(Environment.SystemDirectory, "cmd.exe");
        HelperExeValidator.Validate(cmd, requireSecurePermissions: true);
    }

    [Fact]
    public void Standart_kullanicinin_yazabildigi_dosya_guvenli_izin_istenirse_reddedilir()
    {
        var dir = Path.Combine(Path.GetTempPath(), "sysmon-val-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        try
        {
            var exe = Path.Combine(dir, "helper.exe");
            File.WriteAllText(exe, "MZ");
            var ex = Assert.Throws<HelperExeException>(() => HelperExeValidator.Validate(exe, requireSecurePermissions: true));
            Assert.Equal(HelperExeError.UntrustedPermissions, ex.Error);
            HelperExeValidator.Validate(exe, requireSecurePermissions: false);   // gelistirme: izin denetimi kapali, diger kontroller sürer
        }
        finally { Directory.Delete(dir, true); }
    }

    private static FileSecurity Sec(SecurityIdentifier owner, params (SecurityIdentifier Sid, FileSystemRights Rights, AccessControlType Type)[] rules)
    {
        var s = new FileSecurity();
        s.SetOwner(owner);
        foreach (var r in rules) s.AddAccessRule(new FileSystemAccessRule(r.Sid, r.Rights, r.Type));
        return s;
    }

    private static readonly SecurityIdentifier Admins = new(WellKnownSidType.BuiltinAdministratorsSid, null);
    private static readonly SecurityIdentifier System_ = new(WellKnownSidType.LocalSystemSid, null);
    private static readonly SecurityIdentifier Users = new(WellKnownSidType.BuiltinUsersSid, null);
    private static readonly SecurityIdentifier Everyone = new(WellKnownSidType.WorldSid, null);
    private static readonly SecurityIdentifier TrustedInstaller = new("S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464");

    [Fact]
    public void ValidateSecurity_guvenilir_sahip_ve_yalniz_guvenilir_yazarlar_gecer()
    {
        HelperExeValidator.ValidateSecurity(Sec(TrustedInstaller,
            (TrustedInstaller, FileSystemRights.FullControl, AccessControlType.Allow),
            (Admins, FileSystemRights.FullControl, AccessControlType.Allow),
            (System_, FileSystemRights.FullControl, AccessControlType.Allow),
            (Users, FileSystemRights.ReadAndExecute, AccessControlType.Allow)), "x");
    }

    [Theory]
    [InlineData(FileSystemRights.WriteData)]
    [InlineData(FileSystemRights.AppendData)]
    [InlineData(FileSystemRights.Modify)]
    [InlineData(FileSystemRights.FullControl)]
    [InlineData(FileSystemRights.Delete)]
    [InlineData(FileSystemRights.ChangePermissions)]
    [InlineData(FileSystemRights.TakeOwnership)]
    public void ValidateSecurity_guvenilmeyen_kimlige_yazma_benzeri_hak_verilmisse_reddedilir_sahip_guvenilir_olsa_bile(FileSystemRights r)
    {
        var ex = Assert.Throws<HelperExeException>(() => HelperExeValidator.ValidateSecurity(Sec(Admins,
            (Admins, FileSystemRights.FullControl, AccessControlType.Allow),
            (Users, r, AccessControlType.Allow)), "x"));
        Assert.Equal(HelperExeError.UntrustedPermissions, ex.Error);
        Assert.Throws<HelperExeException>(() => HelperExeValidator.ValidateSecurity(Sec(Admins, (Everyone, r, AccessControlType.Allow)), "x"));
    }

    [Fact]
    public void ValidateSecurity_Deny_kurallari_ve_salt_okuma_haklari_ihlal_sayilmaz()
    {
        HelperExeValidator.ValidateSecurity(Sec(Admins,
            (Users, FileSystemRights.Modify, AccessControlType.Deny),
            (Users, FileSystemRights.ReadAndExecute | FileSystemRights.Synchronize, AccessControlType.Allow)), "x");
    }

    [Fact]
    public void ValidateSecurity_guvenilmeyen_sahip_DACL_guvenli_olsa_bile_reddedilir()
    {
        var me = WindowsIdentity.GetCurrent().User!;
        var ex = Assert.Throws<HelperExeException>(() => HelperExeValidator.ValidateSecurity(Sec(me,
            (Admins, FileSystemRights.FullControl, AccessControlType.Allow),
            (me, FileSystemRights.ReadAndExecute, AccessControlType.Allow)), "x"));
        Assert.Equal(HelperExeError.UntrustedPermissions, ex.Error);
    }

    [Fact]
    public void Goreli_yol_eksik_dosya_ve_klasor_reddedilir_izin_denetimi_kapali_olsa_bile()
    {
        Assert.Equal(HelperExeError.NotAbsolute, Assert.Throws<HelperExeException>(() => HelperExeValidator.Validate("helper.exe", false)).Error);
        Assert.Equal(HelperExeError.NotAbsolute, Assert.Throws<HelperExeException>(() => HelperExeValidator.Validate(@"..\helper.exe", false)).Error);
        Assert.Equal(HelperExeError.NotFound, Assert.Throws<HelperExeException>(() => HelperExeValidator.Validate(Path.Combine(Path.GetTempPath(), "yok-" + Guid.NewGuid().ToString("N") + ".exe"), false)).Error);
        Assert.Equal(HelperExeError.NotFound, Assert.Throws<HelperExeException>(() => HelperExeValidator.Validate(Environment.SystemDirectory, false)).Error);
    }

    [Fact]
    public void Exe_olmayan_uzanti_reddedilir()
    {
        var f = Path.Combine(Path.GetTempPath(), "sysmon-val-" + Guid.NewGuid().ToString("N") + ".txt");
        File.WriteAllText(f, "x");
        try { Assert.Equal(HelperExeError.NotExe, Assert.Throws<HelperExeException>(() => HelperExeValidator.Validate(f, false)).Error); }
        finally { File.Delete(f); }
    }
}
