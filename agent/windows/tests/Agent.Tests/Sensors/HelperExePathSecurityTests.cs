using System.Diagnostics;
using SysMon.Agent.Sensors;

namespace Agent.Tests.Sensors;

/// <summary>Bagimsiz inceleme (M4) I-2: normallesmemis yol ve reparse point (junction) reddi.</summary>
public class HelperExePathSecurityTests
{
    [Fact]
    public void Normallesmemis_tam_nitelikli_yol_reddedilir()
    {
        var root = Path.Combine(Path.GetTempPath(), "sysmon-val-" + Guid.NewGuid().ToString("N"));
        var real = Path.Combine(root, "real");
        Directory.CreateDirectory(real);
        File.WriteAllText(Path.Combine(real, "helper.exe"), "MZ");
        try
        {
            var dotted = Path.Combine(real, "..", "real", "helper.exe");
            Assert.True(Path.IsPathFullyQualified(dotted));
            Assert.Equal(HelperExeError.NotAbsolute, Assert.Throws<HelperExeException>(() => HelperExeValidator.Validate(dotted, false)).Error);
        }
        finally { Directory.Delete(root, true); }
    }

    [Fact]
    public void Dizin_birlesim_noktasi_junction_icindeki_exe_reddedilir()
    {
        var root = Path.Combine(Path.GetTempPath(), "sysmon-val-" + Guid.NewGuid().ToString("N"));
        var real = Path.Combine(root, "real");
        var link = Path.Combine(root, "link");
        Directory.CreateDirectory(real);
        File.WriteAllText(Path.Combine(real, "helper.exe"), "MZ");
        try
        {
            using var mk = Process.Start(new ProcessStartInfo("cmd.exe", $"/c mklink /J \"{link}\" \"{real}\"") { UseShellExecute = false, CreateNoWindow = true })!;
            Assert.True(mk.WaitForExit(10000));
            Assert.Equal(0, mk.ExitCode); // junction ayricalik gerektirmez
            var ex = Assert.Throws<HelperExeException>(() => HelperExeValidator.Validate(Path.Combine(link, "helper.exe"), false));
            Assert.Equal(HelperExeError.ReparsePoint, ex.Error);
        }
        finally
        {
            if (Directory.Exists(link)) Directory.Delete(link); // yalniz baglanti kaldirilir, hedef degil
            Directory.Delete(root, true);
        }
    }
}
