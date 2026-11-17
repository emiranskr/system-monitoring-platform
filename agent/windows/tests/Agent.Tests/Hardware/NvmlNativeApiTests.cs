using System.Diagnostics;
using SysMon.Agent.Hardware;
using SysMon.Agent.Hardware.Nvml;

namespace Agent.Tests.Hardware;

public class NvmlNativeApiTests
{
    [Fact]
    public void DLL_bulunamazsa_Init_LibraryNotFound_doner_firlatmaz()
    {
        using var api = new NvmlNativeApi(Path.Combine(Path.GetTempPath(), "yok-" + Guid.NewGuid().ToString("N") + ".dll"));
        Assert.Equal(NvmlStatus.LibraryNotFound, api.Init());
    }

    [Fact]
    public void DLL_var_ama_NVML_export_yoksa_FunctionNotFound_doner()
    {
        var notNvml = Path.Combine(Environment.SystemDirectory, "kernel32.dll");
        using var api = new NvmlNativeApi(notNvml);
        Assert.Equal(NvmlStatus.FunctionNotFound, api.Init());
    }

    [Fact]
    public void Varsayilan_yukleme_yolu_yalniz_sistem_dizinleridir_arama_yolu_ele_gecirmesine_acik_degil()
    {
        var candidates = NvmlNativeApi.DefaultLibraryCandidates();
        Assert.NotEmpty(candidates);
        Assert.All(candidates, c =>
        {
            Assert.True(Path.IsPathFullyQualified(c), c);
            Assert.EndsWith("nvml.dll", c, StringComparison.OrdinalIgnoreCase);
        });
    }

    [Fact]
    public void Basarisiz_Init_sonrasi_Dispose_guvenli_ve_cift_Dispose_guvenli()
    {
        var api = new NvmlNativeApi(Path.Combine(Path.GetTempPath(), "yok.dll"));
        api.Init();
        api.Dispose();
        api.Dispose();
    }
}

/// <summary>
/// GERCEK donanim: NVIDIA sürücüsü + nvidia-smi gerekir; standart kullanici, salt okunur. Yoksa ACIKCA atlanir (sessizce gecmez).
/// Varsayilan CI kosusunda NVIDIA olmayan makine bu testleri atlar. Filtre: Category=RealHardware.
/// </summary>
public sealed class RealNvidiaFactAttribute : FactAttribute
{
    public RealNvidiaFactAttribute()
    {
        if (!OperatingSystem.IsWindows()) { Skip = "Windows degil"; return; }
        if (NvidiaSmi.Query() is null) Skip = "nvidia-smi bulunamadi/calismadi (NVIDIA surucusu yok): gercek donanim testi atlandi";
    }
}

internal static class NvidiaSmi
{
    public sealed record Reading(double UtilPct, long VramUsedMiB, long VramTotalMiB, double TempC);

    public static Reading? Query()
    {
        try
        {
            using var p = Process.Start(new ProcessStartInfo("nvidia-smi", "--query-gpu=utilization.gpu,memory.used,memory.total,temperature.gpu --format=csv,noheader,nounits")
            { RedirectStandardOutput = true, UseShellExecute = false, CreateNoWindow = true });
            if (p is null) return null;
            var line = p.StandardOutput.ReadLine();
            if (!p.WaitForExit(5000) || p.ExitCode != 0 || line is null) return null;
            var f = line.Split(',', StringSplitOptions.TrimEntries);
            var ci = System.Globalization.CultureInfo.InvariantCulture;
            return new Reading(double.Parse(f[0], ci), long.Parse(f[1], ci), long.Parse(f[2], ci), double.Parse(f[3], ci));
        }
        catch { return null; }
    }
}

[Trait("Category", "RealHardware")]
public class RealNvmlTests
{
    [RealNvidiaFact]
    public async Task Gercek_NVML_nvidia_smi_ile_toleranslar_icinde_uyusur_standart_kullanici()
    {
        using var api = new NvmlNativeApi();
        using var p = new NvmlGpuProvider(api);
        Assert.True(p.IsAvailable(), "nvidia-smi calisiyor ama nvml.dll baslatilamadi");

        var devs = await p.DiscoverAsync(CancellationToken.None);
        Assert.NotEmpty(devs);
        Assert.All(devs, d => Assert.True(GpuCanonicalId.IsValid(d.CanonicalId)));

        // ayni ana yakin: smi, NVML, smi -> NVML degeri iki smi arasinda/tolerans icinde
        var before = NvidiaSmi.Query()!;
        var s = await p.ReadAsync(devs[0], CancellationToken.None);
        var after = NvidiaSmi.Query()!;

        Assert.NotNull(s.UtilPct);
        Assert.NotNull(s.VramTotalBytes);
        Assert.NotNull(s.VramUsedBytes);
        Assert.NotNull(s.TempC);
        Assert.InRange(s.UtilPct!.Value, Math.Min(before.UtilPct, after.UtilPct) - 5, Math.Max(before.UtilPct, after.UtilPct) + 5);
        var usedMiB = s.VramUsedBytes!.Value / (1024.0 * 1024.0);
        Assert.InRange(usedMiB, Math.Min(before.VramUsedMiB, after.VramUsedMiB) - 50, Math.Max(before.VramUsedMiB, after.VramUsedMiB) + 50);
        Assert.InRange(s.VramTotalBytes!.Value / (1024.0 * 1024.0), before.VramTotalMiB - 50, before.VramTotalMiB + 50);
        Assert.InRange(s.TempC!.Value, Math.Min(before.TempC, after.TempC) - 2, Math.Max(before.TempC, after.TempC) + 2);
    }
}
