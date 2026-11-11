using System.IO.Compression;
using System.Net;
using System.Net.Http.Headers;
using System.Text.Json;

namespace SysMon.Agent.Transport;

public enum UploadOutcome
{
    /// <summary>Gonderilecek batch yok.</summary>
    Idle,
    /// <summary>Sunucu batch'i onayladi (kalici ret dahil); spool'dan silindi.</summary>
    Acked,
    /// <summary>Gecici hata: ayni batch yeniden denenecek, spool korunur.</summary>
    Retry,
    /// <summary>TLS dogrulamasi (SPKI pin / sertifika) basarisiz: hicbir veri veya token gonderilmedi; spool korunur.</summary>
    TlsRejected,
    /// <summary>401/403: agent durmali, spool korunur, durum yuzeye cikarilmali.</summary>
    AuthFailed,
}

/// <summary>Ustel geri cekilme: tavan 5 dk, %50-%100 jitter.</summary>
public static class Backoff
{
    public static readonly TimeSpan Cap = TimeSpan.FromMinutes(5);

    public static TimeSpan Next(int attempt, Random rnd)
    {
        var raw = Math.Min(Cap.TotalSeconds, Math.Pow(2, Math.Clamp(attempt, 0, 20)));
        return TimeSpan.FromSeconds(raw * (0.5 + rnd.NextDouble() * 0.5));
    }
}

/// <summary>
/// Stop-and-wait yukleyici: ayni anda tek batch. Spool yalniz sunucu yanitindaki ack_seq
/// batch.Seq'e ulastiginda silinir. Cihaz kimligi govdede tasinmaz; sunucu onu bearer token'dan cozer.
/// </summary>
public sealed class Uploader
{
    private static readonly JsonSerializerOptions Json = new() { PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower };

    private readonly Spool _spool;
    private readonly HttpClient _http;
    private readonly Uri _ingestUrl;
    private readonly Func<string> _token;
    private readonly Func<DateTimeOffset> _now;

    public long RejectedSamples { get; private set; }

    public Uploader(Spool spool, HttpClient http, Uri server, Func<string> token, AgentOptions options, Func<DateTimeOffset> now)
    {
        if (!ServerUrlPolicy.IsAllowed(server, options))
            throw new ArgumentException($"Sunucu adresine izin verilmiyor (https gerekli): {server}");
        _spool = spool;
        _http = http;
        _ingestUrl = new Uri(server, "/agent/v1/ingest");
        _token = token;
        _now = now;
    }

    public async Task<UploadOutcome> UploadOnceAsync(CancellationToken ct)
    {
        var batch = _spool.PeekOldest();
        if (batch is null) return UploadOutcome.Idle;

        using var req = new HttpRequestMessage(HttpMethod.Post, _ingestUrl) { Content = BuildContent(batch) };
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", _token());

        HttpResponseMessage resp;
        try
        {
            resp = await _http.SendAsync(req, ct);
        }
        catch (HttpRequestException ex) when (ex.InnerException is System.Security.Authentication.AuthenticationException)
        {
            return UploadOutcome.TlsRejected;
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException && !ct.IsCancellationRequested)
        {
            return UploadOutcome.Retry; // ag hatasi veya zaman asimi: gecici
        }

        using (resp)
        {
            var status = (int)resp.StatusCode;
            if (status is 401 or 403) return UploadOutcome.AuthFailed;
            var text = await resp.Content.ReadAsStringAsync(ct);

            if (status == 409) // saat sapmasi: server_time ile ofset ogren, ayni batch yeniden denenir
            {
                if (TryGetServerTime(text, out var st)) _spool.SetClockOffset(st - _now());
                return UploadOutcome.Retry;
            }
            if (status != 200) return UploadOutcome.Retry; // 429, 5xx ve beklenmeyen kodlar

            using var doc = JsonDocument.Parse(text);
            var root = doc.RootElement;
            if (!root.TryGetProperty("ack_seq", out var ackEl) || ackEl.GetInt64() < batch.Seq)
                return UploadOutcome.Retry; // onaylanmadi: batch silinmez

            if (root.TryGetProperty("rejected", out var rej)) RejectedSamples += rej.GetInt64();
            if (TryGetServerTime(text, out var serverTime)) _spool.SetClockOffset(serverTime - _now());
            _spool.Ack(batch);
            return UploadOutcome.Acked;
        }
    }

    private HttpContent BuildContent(Batch batch)
    {
        var offset = _spool.ClockOffset;
        var payload = new
        {
            v = 1,
            spool_epoch = batch.Epoch,
            seq = batch.Seq,
            sent_at = (_now() + offset).UtcDateTime.ToString("yyyy-MM-ddTHH:mm:ss'Z'"),
            samples = batch.Samples.Select(s => new
            {
                ts = (s.Ts + offset).UtcDateTime.ToString("yyyy-MM-ddTHH:mm:ss'Z'"),
                m = s.M,
            }),
        };
        var raw = JsonSerializer.SerializeToUtf8Bytes(payload, Json);
        var ms = new MemoryStream();
        using (var gz = new GZipStream(ms, CompressionLevel.Fastest, leaveOpen: true)) gz.Write(raw);
        ms.Position = 0;
        var content = new StreamContent(ms);
        content.Headers.ContentType = new MediaTypeHeaderValue("application/json");
        content.Headers.ContentEncoding.Add("gzip");
        return content;
    }

    private static bool TryGetServerTime(string json, out DateTimeOffset value)
    {
        value = default;
        try
        {
            using var doc = JsonDocument.Parse(json);
            return doc.RootElement.TryGetProperty("server_time", out var el)
                   && DateTimeOffset.TryParse(el.GetString(), out value);
        }
        catch (JsonException) { return false; }
    }
}
