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

        var dataDir = options.DataDir
                      ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "SysMon", "agent");
        var spool = new Spool(Path.Combine(dataDir, "spool"),
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

        var pipeline = new SamplingPipeline(runner, spool, () => DateTimeOffset.UtcNow, SampleInterval, BatchInterval);
        var tasks = new List<Task> { pipeline.RunAsync(stoppingToken) };

        if (options.Server is not null)
        {
            if (options.TokenFile is null || !File.Exists(options.TokenFile))
            {
                log.LogError("--server verildi ama --token-file bulunamadi; yukleme kapali, ornekler spool'a yaziliyor.");
            }
            else
            {
                var uploader = new Uploader(spool, new HttpClient { Timeout = TimeSpan.FromSeconds(30) },
                    new Uri(options.Server), () => File.ReadAllText(options.TokenFile).Trim(), options, () => DateTimeOffset.UtcNow);
                tasks.Add(UploadLoop(uploader, stoppingToken));
            }
        }
        else
        {
            log.LogWarning("--server verilmedi: yukleme kapali, ornekler yalnizca yerel spool'a yaziliyor.");
        }

        await Task.WhenAll(tasks);
    }

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
