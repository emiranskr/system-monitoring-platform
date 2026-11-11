using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using SysMon.Agent;
using SysMon.Agent.Transport;

namespace Agent.Tests.Transport;

/// <summary>Gercek DPAPI ve gercek NTFS ACL ile calisir (yalnizca Windows).</summary>
public sealed class TokenStoreTests : IDisposable
{
    private readonly string _dir = Path.Combine(Path.GetTempPath(), "sysmon-tok-" + Guid.NewGuid().ToString("N"));
    private string StorePath => Path.Combine(_dir, "identity", "token.bin");
    private const string Token = "tok_ABCdef0123456789_UZUN_BIR_TOKEN_DEGERI_xyz";

    public void Dispose()
    {
        if (Directory.Exists(_dir)) Directory.Delete(_dir, true);
    }

    [Fact]
    public void Save_ve_TryLoad_ayni_tokeni_dondurur()
    {
        if (!OperatingSystem.IsWindows()) return;
        var s = new TokenStore(StorePath);
        s.Save(Token);
        Assert.True(s.TryLoad(out var got));
        Assert.Equal(Token, got);
    }

    [Fact]
    public void Diskteki_dosya_duz_metin_token_icermez()
    {
        if (!OperatingSystem.IsWindows()) return;
        new TokenStore(StorePath).Save(Token);
        var bytes = File.ReadAllBytes(StorePath);
        Assert.True(bytes.Length > 16);
        Assert.False(IndexOf(bytes, Encoding.UTF8.GetBytes(Token)) >= 0, "UTF-8 duz metin bulundu");
        Assert.False(IndexOf(bytes, Encoding.Unicode.GetBytes(Token)) >= 0, "UTF-16 duz metin bulundu");
    }

    [Fact]
    public void Dosya_ACL_miras_kapali_ve_genis_gruplara_erisim_yok()
    {
        if (!OperatingSystem.IsWindows()) return;
        new TokenStore(StorePath).Save(Token);
        var sec = new FileInfo(StorePath).GetAccessControl();
        Assert.True(sec.AreAccessRulesProtected, "miras kapali olmali");

        var sids = sec.GetAccessRules(true, true, typeof(SecurityIdentifier))
            .Cast<FileSystemAccessRule>()
            .Where(r => r.AccessControlType == AccessControlType.Allow)
            .Select(r => ((SecurityIdentifier)r.IdentityReference).Value)
            .ToHashSet();

        Assert.DoesNotContain("S-1-1-0", sids);       // Everyone
        Assert.DoesNotContain("S-1-5-32-545", sids);  // Users
        Assert.DoesNotContain("S-1-5-11", sids);      // Authenticated Users
        Assert.Contains("S-1-5-18", sids);            // SYSTEM
        Assert.Contains("S-1-5-32-544", sids);        // Administrators
        Assert.Contains(WindowsIdentity.GetCurrent().User!.Value, sids);
    }

    [Fact]
    public void Ikinci_Save_atomik_degistirir_ve_gecici_dosya_kalmaz()
    {
        if (!OperatingSystem.IsWindows()) return;
        var s = new TokenStore(StorePath);
        s.Save(Token);
        s.Save("yeni-token-" + Token);
        Assert.True(s.TryLoad(out var got));
        Assert.Equal("yeni-token-" + Token, got);
        Assert.Empty(Directory.GetFiles(Path.GetDirectoryName(StorePath)!, "*.tmp"));
    }

    [Fact]
    public void Eksik_veya_bozuk_dosyada_TryLoad_false_doner()
    {
        if (!OperatingSystem.IsWindows()) return;
        var s = new TokenStore(StorePath);
        Assert.False(s.TryLoad(out _));
        Directory.CreateDirectory(Path.GetDirectoryName(StorePath)!);
        File.WriteAllBytes(StorePath, new byte[] { 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20 });
        Assert.False(s.TryLoad(out var got));
        Assert.Null(got);
    }

    [Theory]
    [InlineData("")]
    [InlineData("   ")]
    public void Bos_token_kaydedilmez(string bad)
    {
        if (!OperatingSystem.IsWindows()) return;
        Assert.Throws<ArgumentException>(() => new TokenStore(StorePath).Save(bad));
    }

    [Fact]
    public async Task Eszamanli_yazma_sirasinda_okuyucu_hic_bozuk_deger_gormez()
    {
        if (!OperatingSystem.IsWindows()) return;
        var s = new TokenStore(StorePath);
        s.Save("t0-" + Token);
        var stop = false;
        var failures = 0;
        var reads = 0;
        var reader = Task.Run(() =>
        {
            while (!Volatile.Read(ref stop))
            {
                if (!s.TryLoad(out var t) || t is null || !t.EndsWith(Token)) Interlocked.Increment(ref failures);
                Interlocked.Increment(ref reads);
            }
        });
        for (var i = 1; i <= 150; i++) s.Save($"t{i}-{Token}");
        Volatile.Write(ref stop, true);
        await reader;
        Assert.True(reads > 50, $"okuma sayisi dusuk: {reads}");
        Assert.Equal(0, failures);
    }

    [Fact]
    public void Import_duz_metin_dosyayi_siler_ve_korumali_depoya_yazar()
    {
        if (!OperatingSystem.IsWindows()) return;
        Directory.CreateDirectory(_dir);
        var plain = Path.Combine(_dir, "bootstrap.txt");
        File.WriteAllText(plain, "  " + Token + "\r\n");
        var s = new TokenStore(StorePath);

        TokenImporter.Import(plain, s);

        Assert.False(File.Exists(plain), "duz metin dosya silinmeli");
        Assert.True(s.TryLoad(out var got));
        Assert.Equal(Token, got); // bosluk ve satir sonu kirpilir
    }

    [Fact]
    public void Import_bos_dosyayi_reddeder_ve_dosyayi_silmez()
    {
        if (!OperatingSystem.IsWindows()) return;
        Directory.CreateDirectory(_dir);
        var plain = Path.Combine(_dir, "bos.txt");
        File.WriteAllText(plain, "\r\n");
        Assert.Throws<ArgumentException>(() => TokenImporter.Import(plain, new TokenStore(StorePath)));
        Assert.True(File.Exists(plain));
    }

    [Fact]
    public void Parse_import_token_secenegini_okur()
    {
        var o = AgentOptions.Parse(["--import-token", "t.txt"]);
        Assert.Equal("t.txt", o.ImportToken);
    }

    private static int IndexOf(byte[] hay, byte[] needle)
    {
        for (var i = 0; i + needle.Length <= hay.Length; i++)
            if (hay.AsSpan(i, needle.Length).SequenceEqual(needle)) return i;
        return -1;
    }
}

public sealed class TokenStoreExtraPrincipalTests : IDisposable
{
    private readonly string _dir = Path.Combine(Path.GetTempPath(), "sysmon-tokx-" + Guid.NewGuid().ToString("N"));
    private string StorePath => Path.Combine(_dir, "identity", "token.bin");

    public void Dispose()
    {
        if (Directory.Exists(_dir)) Directory.Delete(_dir, true);
    }



    [Fact]
    public void Bilinmeyen_hesap_adi_ArgumentException_firlatir_ve_dosya_olusmaz()
    {
        var store = new TokenStore(StorePath, [@"NT SERVICE\OlmayanServis" + Guid.NewGuid().ToString("N")]);
        Assert.Throws<ArgumentException>(() => store.Save("tok_x_0123456789abcdef0123456789"));
        Assert.False(File.Exists(StorePath));
    }

    [Fact]
    public void Parse_token_reader_secenegini_okur()
    {
        var o = AgentOptions.Parse(["--import-token", "t.txt", "--token-reader", @"NT SERVICE\SysMonAgent"]);
        Assert.Equal(@"NT SERVICE\SysMonAgent", o.TokenReader);
    }
}
