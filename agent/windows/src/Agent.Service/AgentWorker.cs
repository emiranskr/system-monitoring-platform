using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using SysMon.Agent.Collectors;
using SysMon.Agent.Transport;

namespace SysMon.Agent;

/// <summary>Collector -> spool hatti ve (sunucu verilmisse) spool -> sunucu yukleme dongusu.</summary>
public sealed class AgentWorker(AgentOptions options, ILogger<AgentWorker> log) : BackgroundService
{
    private static readonly TimeSpan SampleInterval = TimeSpan.FromSeconds(1);
    private static readonly TimeSpan BatchInterval = TimeSpan.FromSeconds(5);

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        if (!OperatingSystem.IsWindows())
        {
            log.LogError("Bu agent yalnizca Windows'ta calisir.");
            return;
        }

        var spool = new Spool(AgentPaths.SpoolDir(options),
            new SpoolLimits(MaxBytes: 50L * 1024 * 1024, MaxAge: TimeSpan.FromHours(24), SegmentBytes: 1024 * 1024),
            () => DateTimeOffset.UtcNow);

        using var cpu = new PdhCpuSource();
        var runner = new CollectorRunner(
        [
            new CpuCollector(cpu),
            new MemoryCollector(new WindowsMemoryInfoSource()),
            new DiskCollector(new SystemDriveSource()),
            new NetworkCollector(new SystemNetworkSource(), () => Environment.TickCount64),
        ], TimeSpan.FromSeconds(2));

        var pipeline = new SamplingPipeline(runner, spool, () => DateTimeOffset.UtcNow, SampleInterval, BatchInterval,
            onStatusChange: st =>
            {
                if (st.Ok) log.LogInformation("Collector {Name} duzeldi.", st.Name);
                else log.LogWarning("Collector {Name} calismiyor: {Message}", st.Name, st.Message);
            });
        var tasks = new List<Task> { pipeline.RunAsync(stoppingToken) };

        if (options.Server is not null)
        {
            var store = new TokenStore(AgentPaths.TokenStorePath(options));
            if (!store.TryLoad(out _))
            {
                log.LogError("Korumali token deposu yok veya okunamadi ({Path}); --import-token ile token iceri aktarin. Yukleme kapali, ornekler spool a yaziliyor.", store.Path);
            }
            else
            {
                var uploader = new Uploader(spool, HttpClients.Create(options.ServerPins), new Uri(options.Server),
                    () => ReadToken(store),
                    options, () => DateTimeOffset.UtcNow);
                log.LogInformation("Yukleme etkin: sunucu {Server}, SPKI pin sayisi {Pins}, korumali token okundu.",
                    options.Server, options.ServerPins?.Count ?? 0);
                tasks.Add(UploadLoop(uploader, stoppingToken));
            }
        }
        else
        {
            log.LogWarning("--server verilmedi: yukleme kapali, ornekler yalnizca yerel spool'a yaziliyor.");
        }

        await Task.WhenAll(tasks);
    }

    [System.Runtime.Versioning.SupportedOSPlatform("windows")]
    private static string ReadToken(TokenStore store) =>
        store.TryLoad(out var t) ? t! : throw new InvalidOperationException("Token okunamadi.");

    private async Task UploadLoop(Uploader uploader, CancellationToken ct)
    {
        var attempt = 0;
        var rnd = new Random();
        while (!ct.IsCancellationRequested)
        {
            try
            {
                switch (await uploader.UploadOnceAsync(ct))
                {
                    case UploadOutcome.Acked:
                        attempt = 0;
                        break;
                    case UploadOutcome.Idle:
                        attempt = 0;
                        await Task.Delay(TimeSpan.FromSeconds(1), ct);
                        break;
                    case UploadOutcome.Retry:
                        var wait = Backoff.Next(attempt++, rnd);
                        log.LogWarning("Yukleme basarisiz, {Wait:0.0} sn sonra yeniden denenecek.", wait.TotalSeconds);
                        await Task.Delay(wait, ct);
                        break;
                    case UploadOutcome.TlsRejected:
                        log.LogError("Sunucu sertifikasi dogrulanamadi (SPKI pin / sertifika). 5 dk sonra yeniden denenecek; veri ve token gonderilmedi.");
                        await Task.Delay(Backoff.Cap, ct);
                        break;
                    case UploadOutcome.AuthFailed:
                        log.LogError("Sunucu kimlik bilgisini reddetti (401/403). Yukleme durduruldu; ornekler spool'da korunuyor.");
                        return;
                }
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested)
            {
                return;
            }
        }
    }
}
