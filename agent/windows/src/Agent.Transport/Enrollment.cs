using System.Net;
using System.Net.Http.Json;
using System.Security.Authentication;
using System.Text;
using System.Text.Json;

namespace SysMon.Agent.Transport;

public sealed record NamedItem(string Id, string Name);
public sealed record GpuInfo(string CanonicalId, string Name);

/// <summary>Sunucudaki DeviceInfoSchema (packages/protocol/src/enroll.ts) ile birebir: strict, uzunluk siniri var.</summary>
public sealed record DeviceInfo(
    string Hostname, string Os, string AgentVersion,
    IReadOnlyList<GpuInfo> Gpus, IReadOnlyList<NamedItem> Adapters, IReadOnlyList<NamedItem> Volumes);

/// <summary>Sunucu sozlesmesinin sinirlarina (alan uzunluklari, liste boyutlari) uyan DeviceInfo uretir: asiri/bozuk deger kaydi reddettirmez.</summary>
public static class DeviceInfoBuilder
{
    public const int MaxGpus = 16, MaxAdapters = 64, MaxVolumes = 64;

    public static DeviceInfo Build(string hostname, string os, string agentVersion,
        IEnumerable<GpuInfo> gpus, IEnumerable<NamedItem> adapters, IEnumerable<NamedItem> volumes) =>
        new(Clip(hostname, 255, "unknown"), Clip(os, 128, "Windows"), Clip(agentVersion, 32, "0.0.0"),
            gpus.Select(g => new GpuInfo(Clip(g.CanonicalId, 64, ""), Clip(g.Name, 128, "GPU"))).Where(g => g.CanonicalId.Length > 0)
                .DistinctBy(g => g.CanonicalId).Take(MaxGpus).ToList(),
            Items(adapters, MaxAdapters), Items(volumes, MaxVolumes));

    private static List<NamedItem> Items(IEnumerable<NamedItem> src, int max) =>
        src.Select(i => new NamedItem(Clip(i.Id, 64, ""), Clip(i.Name, 128, i.Id))).Where(i => i.Id.Length > 0)
            .DistinctBy(i => i.Id).Take(max).ToList();

    private static string Clip(string? s, int max, string fallback)
    {
        var t = (s ?? "").Trim();
        if (t.Length == 0) t = fallback;
        return t.Length <= max ? t : t[..max];
    }
}

public enum EnrollOutcome
{
    Enrolled,
    /// <summary>401 (gecersiz, kullanilmis veya suresi dolmus kayit belirteci; sunucu bunlari ayirt ettirmez).</summary>
    Rejected,
    /// <summary>429: hiz siniri; daha sonra tekrar denenir.</summary>
    RateLimited,
    /// <summary>5xx veya sozlesmeye uymayan yanit: gecici/ilgisiz; ayni enroll_id ile yeniden denenebilir.</summary>
    ServerError,
    /// <summary>TLS dogrulamasi (SPKI pin / sertifika) basarisiz: belirec GONDERILMEDI.</summary>
    TlsRejected,
    /// <summary>Baglanti/zaman asimi: ayni enroll_id ile yeniden denenebilir.</summary>
    NetworkError,
    /// <summary>Diger 4xx (istek biciminin reddi vb.): yeniden denemek anlamsiz.</summary>
    ClientError,
}

public sealed record EnrollResult(EnrollOutcome Outcome, Guid DeviceId = default, string? Credential = null, IReadOnlyList<string>? SpkiPins = null);

/// <summary>
/// Kayit (enrollment): tek kullanimlik belirec + cihaz bilgisi -> kalici cihaz kimlik bilgisi (POST /agent/v1/enroll).
/// Idempotent yeniden deneme icin AYNI enroll_id kullanilmali (sunucu 10 dk icinde ayni kimlik bilgisini dondurur).
/// Belirec ve kimlik bilgisi HICBIR yerde loglanmaz/istisna iletisine konmaz.
/// </summary>
public static class Enroller
{
    private static readonly JsonSerializerOptions Json = new() { PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower };

    public static async Task<EnrollResult> EnrollAsync(HttpClient http, Uri server, string enrollmentToken, Guid enrollId, string machineGuid,
        DeviceInfo info, CancellationToken ct = default)
    {
        var url = new Uri(server, "/agent/v1/enroll");
        var body = new
        {
            token = enrollmentToken,
            enroll_id = enrollId.ToString(),
            machine_guid = machineGuid,
            device_info = new
            {
                hostname = info.Hostname, os = info.Os, agent_version = info.AgentVersion,
                gpus = info.Gpus.Select(g => new { canonical_id = g.CanonicalId, name = g.Name }),
                adapters = info.Adapters.Select(a => new { id = a.Id, name = a.Name }),
                volumes = info.Volumes.Select(v => new { id = v.Id, name = v.Name }),
            },
        };
        try
        {
            using var req = new HttpRequestMessage(HttpMethod.Post, url)
            {
                Content = new StringContent(JsonSerializer.Serialize(body, Json), Encoding.UTF8, "application/json"),
            };
            using var res = await http.SendAsync(req, ct).ConfigureAwait(false);
            switch ((int)res.StatusCode)
            {
                case 200 or 201:
                    return await ParseAsync(res, ct).ConfigureAwait(false);
                case 401:
                    return new EnrollResult(EnrollOutcome.Rejected);
                case 429:
                    return new EnrollResult(EnrollOutcome.RateLimited);
                case >= 500:
                    return new EnrollResult(EnrollOutcome.ServerError);
                default:
                    return new EnrollResult(EnrollOutcome.ClientError);
            }
        }
        catch (HttpRequestException e) when (e.InnerException is AuthenticationException || e.HttpRequestError == HttpRequestError.SecureConnectionError)
        {
            return new EnrollResult(EnrollOutcome.TlsRejected);
        }
        catch (Exception e) when (e is HttpRequestException or TaskCanceledException or IOException)
        {
            if (ct.IsCancellationRequested) throw;
            return new EnrollResult(EnrollOutcome.NetworkError);
        }
    }

    private static async Task<EnrollResult> ParseAsync(HttpResponseMessage res, CancellationToken ct)
    {
        try
        {
            using var doc = await JsonDocument.ParseAsync(await res.Content.ReadAsStreamAsync(ct).ConfigureAwait(false), cancellationToken: ct).ConfigureAwait(false);
            var r = doc.RootElement;
            var okId = Guid.TryParse(r.GetProperty("device_id").GetString(), out var id);
            var cred = r.GetProperty("credential").GetString();
            var pins = r.GetProperty("spki_pins").EnumerateArray().Select(p => p.GetString() ?? "").Where(p => p.Length > 0).ToList();
            if (!okId || cred is null || cred.Length is < 32 or > 128) return new EnrollResult(EnrollOutcome.ServerError);
            return new EnrollResult(EnrollOutcome.Enrolled, id, cred, pins);
        }
        catch (Exception e) when (e is JsonException or KeyNotFoundException or InvalidOperationException or FormatException)
        {
            return new EnrollResult(EnrollOutcome.ServerError);   // sozlesmeye uymayan yanit: kimlik bilgisi uretilmis sayilmaz
        }
    }
}

public enum RotateOutcome { Rotated, Rejected, RateLimited, ServerError, TlsRejected, NetworkError, Conflict, ClientError }

public sealed record RotateResult(RotateOutcome Outcome, string? Credential = null, DateTimeOffset? OverlapExpiresAt = null);

/// <summary>
/// Kimlik bilgisi dondurme (POST /agent/v1/rotate, mevcut kimlik bilgisiyle Bearer). Ayni rotation_id AYNI yeni kimlik bilgisini dondurur
/// (kayip yanit guvenle yeniden denenir). Sunucu 24 saat eski+yeni kimlik bilgisini birlikte kabul eder; yeni kimlik bilgisi ilk kullanildiginda eskisi iptal olur.
/// </summary>
public static class Rotator
{
    private static readonly JsonSerializerOptions Json = new() { PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower };

    public static async Task<RotateResult> RotateAsync(HttpClient http, Uri server, string currentCredential, Guid rotationId, CancellationToken ct = default)
    {
        try
        {
            using var req = new HttpRequestMessage(HttpMethod.Post, new Uri(server, "/agent/v1/rotate"))
            {
                Content = new StringContent(JsonSerializer.Serialize(new { rotation_id = rotationId.ToString() }, Json), Encoding.UTF8, "application/json"),
            };
            req.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", currentCredential);
            using var res = await http.SendAsync(req, ct).ConfigureAwait(false);
            switch ((int)res.StatusCode)
            {
                case 200 or 201:
                    try
                    {
                        using var doc = await JsonDocument.ParseAsync(await res.Content.ReadAsStreamAsync(ct).ConfigureAwait(false), cancellationToken: ct).ConfigureAwait(false);
                        var cred = doc.RootElement.GetProperty("credential").GetString();
                        var ok = DateTimeOffset.TryParse(doc.RootElement.GetProperty("overlap_expires_at").GetString(), System.Globalization.CultureInfo.InvariantCulture,
                            System.Globalization.DateTimeStyles.AssumeUniversal, out var until);
                        return cred is { Length: >= 32 and <= 128 } && ok ? new RotateResult(RotateOutcome.Rotated, cred, until) : new RotateResult(RotateOutcome.ServerError);
                    }
                    catch (Exception e) when (e is JsonException or KeyNotFoundException or InvalidOperationException or FormatException)
                    {
                        return new RotateResult(RotateOutcome.ServerError);
                    }
                case 401 or 403: return new RotateResult(RotateOutcome.Rejected);
                case 409: return new RotateResult(RotateOutcome.Conflict);   // bekleyen baska rotation var (farkli rotation_id)
                case 429: return new RotateResult(RotateOutcome.RateLimited);
                case >= 500: return new RotateResult(RotateOutcome.ServerError);
                default: return new RotateResult(RotateOutcome.ClientError);
            }
        }
        catch (HttpRequestException e) when (e.InnerException is AuthenticationException || e.HttpRequestError == HttpRequestError.SecureConnectionError)
        {
            return new RotateResult(RotateOutcome.TlsRejected);
        }
        catch (Exception e) when (e is HttpRequestException or TaskCanceledException or IOException)
        {
            if (ct.IsCancellationRequested) throw;
            return new RotateResult(RotateOutcome.NetworkError);
        }
    }
}
