using System.Net.NetworkInformation;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using Microsoft.Win32;
using SysMon.Agent.Collectors;
using SysMon.Agent.Hardware.Nvml;
using SysMon.Agent.Transport;

namespace SysMon.Agent;

/// <summary>
/// `--enroll &lt;belirec-dosyasi&gt; --server https://...`: tek kullanimlik kayit belirecini sunucuda kalici cihaz kimlik bilgisine cevirir,
/// kimlik bilgisini korumali depoya (DPAPI) yazar ve belirec dosyasini siler. Cihaz bilgisi (ad, OS, GPU/ag/disk listesi) sunucuya gonderilir.
/// Belirec komut satirinda GECMEZ (surec listesinde gorunurdu), dosyadan okunur. Cikis kodlari: 0 basarili, 2 girdi hatasi, 3 belirec reddedildi,
/// 4 hiz siniri, 5 gecici hata (ayni komut yeniden denenebilir; enroll_id veri dizininde saklanir), 6 TLS dogrulamasi basarisiz, 7 diger reddedilme.
/// </summary>
[SupportedOSPlatform("windows")]
public static class EnrollCommand
{
    public static async Task<int> RunAsync(AgentOptions o, TextWriter output, TextWriter error, CancellationToken ct = default)
    {
        var tokenFile = o.EnrollTokenFile!;
        string enrollToken;
        try { enrollToken = File.ReadAllText(tokenFile).Trim(); }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            error.WriteLine($"Kayit belirteci dosyasi okunamadi: {tokenFile}");
            return 2;
        }
        if (enrollToken.Length == 0) { error.WriteLine("Kayit belirteci dosyasi bos."); return 2; }

        var server = new Uri(o.Server!);
        if (!ServerUrlPolicy.IsAllowed(server, o))
        {
            error.WriteLine("--server adresine izin verilmiyor: https gerekir (http yalnizca Debug derlemesinde, loopback ve --allow-insecure-loopback ile).");
            return 2;
        }

        // Idempotent yeniden deneme: enroll_id kalici; basari sonrasi silinir. Yanit kaybolursa ayni komut ayni kimlik bilgisini geri alir (10 dk).
        var dataDir = AgentPaths.DataDir(o);
        Directory.CreateDirectory(dataDir);
        var idFile = Path.Combine(dataDir, "enroll-id");
        var enrollId = File.Exists(idFile) && Guid.TryParse(File.ReadAllText(idFile).Trim(), out var saved) ? saved : Guid.NewGuid();
        File.WriteAllText(idFile, enrollId.ToString());

        var info = await CollectDeviceInfoAsync(ct).ConfigureAwait(false);
        using var http = HttpClients.Create(o.ServerPins);
        var r = await Enroller.EnrollAsync(http, server, enrollToken, enrollId, MachineGuid(), info, ct).ConfigureAwait(false);

        switch (r.Outcome)
        {
            case EnrollOutcome.Enrolled:
                var store = new TokenStore(AgentPaths.TokenStorePath(o), o.TokenReader is null ? null : [o.TokenReader]);
                store.Save(r.Credential!);
                if (!store.TryLoad(out var check) || check != r.Credential)
                {
                    error.WriteLine("Kimlik bilgisi korumali depoya yazildi ama dogrulanamadi; belirec dosyasi SILINMEDI, komutu yeniden calistirin.");
                    return 5;
                }
                TryWipe(tokenFile);
                File.Delete(idFile);
                output.WriteLine($"Kayit tamam. Cihaz kimligi: {r.DeviceId}");
                output.WriteLine($"Kimlik bilgisi korumali depoya yazildi: {store.Path}");
                if (r.SpkiPins is { Count: > 0 }) output.WriteLine("Sunucu sertifika pin(ler)i (servisi --server-pin ile yapilandirirken kullanin): " + string.Join(", ", r.SpkiPins));
                return 0;
            case EnrollOutcome.Rejected: error.WriteLine("Kayit reddedildi: belirec gecersiz, kullanilmis veya suresi dolmus."); return 3;
            case EnrollOutcome.RateLimited: error.WriteLine("Cok fazla deneme (hiz siniri). Biraz bekleyip yeniden deneyin."); return 4;
            case EnrollOutcome.TlsRejected: error.WriteLine("TLS dogrulamasi basarisiz (sertifika/pin). Belirec GONDERILMEDI."); return 6;
            case EnrollOutcome.ClientError: error.WriteLine("Sunucu istegi reddetti (beklenmeyen 4xx). Agent ve sunucu surumlerini kontrol edin."); return 7;
            default: error.WriteLine("Sunucuya ulasilamadi veya gecici sunucu hatasi. Ayni komutu yeniden calistirin (ayni enroll_id kullanilir)."); return 5;
        }
    }

    private static async Task<DeviceInfo> CollectDeviceInfoAsync(CancellationToken ct)
    {
        var gpus = new List<GpuInfo>();
        try
        {
            using var api = new NvmlNativeApi();
            using var nvml = new NvmlGpuProvider(api);
            using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
            cts.CancelAfter(TimeSpan.FromSeconds(5));
            foreach (var g in await nvml.DiscoverAsync(cts.Token).ConfigureAwait(false)) gpus.Add(new GpuInfo(g.CanonicalId, g.Name));
        }
        catch (Exception e) when (e is not OperationCanceledException || !ct.IsCancellationRequested)
        {
            // NVML/surucu yok veya okunamadi: GPU listesi bos kalir; kayit yine yapilir.
        }

        var adapters = new List<NamedItem>();
        try
        {
            foreach (var n in NetworkInterface.GetAllNetworkInterfaces())
            {
                var monitored = false;
                try { monitored = NicFilter.IsMonitored(() => new NicInfo(n.Name, n.Description, n.NetworkInterfaceType, n.OperationalStatus, n.GetIPProperties().UnicastAddresses.Select(u => u.Address).ToList())); }
                catch (Exception e) when (e is NetworkInformationException or InvalidOperationException) { }
                if (monitored) adapters.Add(new NamedItem(MetricNames.SanitizeUnique(n.Name), n.Name));   // id: metrik anahtariyla AYNI (net.<id>.rx_bps)
            }
        }
        catch (NetworkInformationException) { }

        var volumes = DriveInfo.GetDrives().Where(d => d.DriveType == DriveType.Fixed && d.IsReady)
            .Select(d => new NamedItem(MetricNames.Sanitize(d.Name[..1].ToUpperInvariant()), d.Name[..2])).ToList();

        var version = typeof(EnrollCommand).Assembly.GetName().Version?.ToString(3) ?? "0.0.0";
        return DeviceInfoBuilder.Build(Environment.MachineName, RuntimeInformation.OSDescription, version, gpus, adapters, volumes);
    }

    private static string MachineGuid()
    {
        using var key = RegistryKey.OpenBaseKey(RegistryHive.LocalMachine, RegistryView.Registry64).OpenSubKey(@"SOFTWARE\Microsoft\Cryptography");
        var g = key?.GetValue("MachineGuid") as string;
        return string.IsNullOrWhiteSpace(g) ? Environment.MachineName : g!;
    }

    private static void TryWipe(string path)
    {
        try
        {
            File.WriteAllBytes(path, new byte[new FileInfo(path).Length]);   // en iyi caba: silmeden once uzerine yaz
            File.Delete(path);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException) { /* belirec zaten tek kullanimlik ve tuketildi */ }
    }
}
