using System.Globalization;
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
    /// <summary>401/403: kimlik hatasi, 5 dk aralikla yeniden denenir, spool korunur.</summary>
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
    private static readonly TimeSpan MaxClockOffset = TimeSpan.FromDays(366);

    private readonly Spool _spool;
    private readonly HttpClient _http;
    private readonly Uri _ingestUrl;
    private readonly Func<string> _token;
    private readonly SamplingConfig? _sampling;
    private readonly Func<DateTimeOffset> _now;

    private Guid _lastBatchEpoch = Guid.Empty;
    private long _lastBatchSeq = -1;
    private int _consecutivePermanent4xx;

    public event Action<Batch, int>? BatchDropped;

    public long RejectedSamples { get; private set; }

    public Uploader(Spool spool, HttpClient http, Uri server, Func<string> token, AgentOptions options, Func<DateTimeOffset> now,
        SamplingConfig? sampling = null)
    {
        if (!ServerUrlPolicy.IsAllowed(server, options))
            throw new ArgumentException($"Sunucu adresine izin verilmiyor (https gerekli): {server}");
        _spool = spool;
        _http = http;
        _ingestUrl = new Uri(server, "/agent/v1/ingest");
        _token = token;
        _now = now;
        _sampling = sampling;
    }

    public async Task<UploadOutcome> UploadOnceAsync(CancellationToken ct)
    {
        var batch = _spool.PeekOldest();
        if (batch is null) return UploadOutcome.Idle;

        // Token yoksa/okunamiyorsa bos "Bearer" ile istek GONDERME: sunucuya gereksiz yuk ve yaniltici 401 olur.
        // Neden TokenProvider tarafindan loglanir; runner AuthFailed'da bekleyip yeniden dener (token gelince devam).
        var token = _token();
        if (string.IsNullOrWhiteSpace(token)) return UploadOutcome.AuthFailed;

        if (batch.Epoch != _lastBatchEpoch || batch.Seq != _lastBatchSeq)
        {
            _lastBatchEpoch = batch.Epoch;
            _lastBatchSeq = batch.Seq;
            _consecutivePermanent4xx = 0;
        }

        using var req = new HttpRequestMessage(HttpMethod.Post, _ingestUrl) { Content = BuildContent(batch) };
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);

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
                TryApplyServerTime(text);
                return UploadOutcome.Retry;
            }

            // O8: Kalici 4xx hatalari (400, 404, 413, 422 vs.; 408, 429 ve 409 haric).
            // Ayni batch icin ardisik 10 kalici 4xx alindiginda batch atilir, boylece hat kilitlenmez.
            var isPermanent4xx = status is >= 400 and < 500 and not 408 and not 429;
            if (isPermanent4xx)
            {
                _consecutivePermanent4xx++;
                if (_consecutivePermanent4xx >= 10)
                {
                    _spool.Ack(batch);
                    BatchDropped?.Invoke(batch, status);
                    _consecutivePermanent4xx = 0;
                    return UploadOutcome.Acked;
                }
                return UploadOutcome.Retry;
            }

            if (status != 200) return UploadOutcome.Retry; // 429, 408, 5xx ve beklenmeyen kodlar: gecici

            // Sunucu yaniti guvenilmez girdi sayilir (proxy HTML sayfasi, eksik alan, yanlis tip): hicbiri istisna
            // firlatmaz; dogrulanamayan yanit onay degildir -> batch korunur, yeniden denenir.
            long ack;
            long rejected = 0;
            JsonElement? serverInterval = null;
            try
            {
                using var doc = JsonDocument.Parse(text);
                var root = doc.RootElement;
                if (root.ValueKind != JsonValueKind.Object
                    || !root.TryGetProperty("ack_seq", out var ackEl)
                    || ackEl.ValueKind != JsonValueKind.Number
                    || !ackEl.TryGetInt64(out ack))
                    return UploadOutcome.Retry;
                if (root.TryGetProperty("rejected", out var rej) && rej.ValueKind == JsonValueKind.Number && rej.TryGetInt64(out var rj))
                    rejected = rj;
                if (root.TryGetProperty("config", out var cfg) && cfg.ValueKind == JsonValueKind.Object
                    && cfg.TryGetProperty("interval_seconds", out var iv))
                    serverInterval = iv.Clone();
            }
            catch (JsonException)
            {
                return UploadOutcome.Retry;
            }
            if (ack < batch.Seq) return UploadOutcome.Retry; // onaylanmadi: batch silinmez

            _consecutivePermanent4xx = 0; // basarili onay kalici hata sayacini sifirlar
            RejectedSamples += rejected;
            if (serverInterval is { } si) _sampling?.TryApplyServerSeconds(si); // yalniz GECERLI onaydan sonra
            TryApplyServerTime(text);
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
            sent_at = (_now() + offset).UtcDateTime.ToString("yyyy-MM-ddTHH:mm:ss'Z'", CultureInfo.InvariantCulture),
            samples = batch.Samples.Select(s => new
            {
                ts = (s.Ts + offset).UtcDateTime.ToString("yyyy-MM-ddTHH:mm:ss'Z'", CultureInfo.InvariantCulture),
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

    private void TryApplyServerTime(string json)
    {
        if (!TryGetServerTime(json, out var st)) return;
        var diff = st - _now();
        if (diff.Duration() > MaxClockOffset) return;
        _spool.SetClockOffset(diff);
    }

    private static bool TryGetServerTime(string json, out DateTimeOffset value)
    {
        value = default;
        try
        {
            using var doc = JsonDocument.Parse(json);
            if (doc.RootElement.ValueKind != JsonValueKind.Object
                || !doc.RootElement.TryGetProperty("server_time", out var el)
                || el.ValueKind != JsonValueKind.String)
                return false;
            var str = el.GetString();
            if (string.IsNullOrWhiteSpace(str)) return false;
            return DateTimeOffset.TryParse(str, CultureInfo.InvariantCulture,
                DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal, out value);
        }
        catch (JsonException) { return false; }
    }
}
