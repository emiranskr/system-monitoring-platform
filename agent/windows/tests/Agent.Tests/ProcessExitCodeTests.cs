using System.Diagnostics;
using SysMon.Agent.Transport;

namespace Agent.Tests;

/// <summary>I-1: Surec cikis kodu GERCEK surec olarak gozlenir (statik Environment.ExitCode degil).</summary>
public sealed class ProcessExitCodeTests : IDisposable
{
    private readonly string _dataDir = Path.Combine(Path.GetTempPath(), "sysmon-exit-" + Guid.NewGuid().ToString("N"));

    public void Dispose()
    {
        if (Directory.Exists(_dataDir)) Directory.Delete(_dataDir, true);
    }

    /// <summary>Test cikis dizininde Hosting derlemeleri yoktur; servisin kendi (eksiksiz) derleme dizinindeki exe kullanilir.</summary>
    private static string ServiceExe()
    {
        var baseDir = new DirectoryInfo(AppContext.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar)); // ...\bin\<Config>\net10.0-windows
        var config = baseDir.Parent!.Name;
        var root = baseDir.Parent.Parent!.Parent!.Parent!.Parent!; // agent\windows
        var exe = Path.Combine(root.FullName, "src", "Agent.Service", "bin", config, baseDir.Name, "Agent.Service.exe");
        Assert.True(File.Exists(exe), $"Agent.Service.exe bulunamadi: {exe}");
        return exe;
    }

    private static (int ExitCode, string Output) Run(params string[] args)
    {
        var exe = ServiceExe();
        var psi = new ProcessStartInfo(exe) { RedirectStandardOutput = true, RedirectStandardError = true, UseShellExecute = false };
        foreach (var a in args) psi.ArgumentList.Add(a);
        using var p = Process.Start(psi)!;
        var output = p.StandardOutput.ReadToEndAsync();
        var error = p.StandardError.ReadToEndAsync();
        if (!p.WaitForExit(30_000)) { p.Kill(true); throw new TimeoutException("Surec 30 sn icinde bitmedi."); }
        return (p.ExitCode, output.Result + error.Result);
    }

    [Fact]
    public void Veri_dizini_baska_ornekte_kilitliyse_surec_cikis_kodu_1_olur()
    {
        if (!OperatingSystem.IsWindows()) return;
        using var held = InstanceLock.TryAcquire(_dataDir);
        Assert.NotNull(held);

        var (code, _) = Run("--data-dir", _dataDir);

        Assert.Equal(1, code);
    }

    [Fact]
    public void Gecersiz_arguman_cikis_kodu_2_olur()
    {
        var (code, output) = Run("--server", "ftp://ornek");
        Assert.Equal(2, code);
        Assert.False(string.IsNullOrWhiteSpace(output));
    }

    [Fact]
    public void Ikinci_surec_cikinca_ilk_ornegin_kilidi_korunur()
    {
        if (!OperatingSystem.IsWindows()) return;
        using var held = InstanceLock.TryAcquire(_dataDir);
        Assert.NotNull(held);

        Run("--data-dir", _dataDir);

        Assert.Null(InstanceLock.TryAcquire(_dataDir)); // kilit hala ilk orneginde
    }
}
