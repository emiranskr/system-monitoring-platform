using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using SysMon.Agent.Collectors;
using SysMon.Agent.Transport;

namespace SysMon.Agent;

/// <summary>Collector -> spool hatti ve (sunucu verilmisse) spool -> sunucu yukleme dongusu.</summary>
public sealed class AgentWorker(AgentOptions options, ILogger<AgentWorker> log, IHostApplicationLifetime lifetime) : BackgroundService
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

        await Task.Yield(); // host baslatmasini asenkron birak

        var dataDir = AgentPaths.DataDir(options);
        using var instanceLock = InstanceLock.TryAcquire(dataDir);
        if (instanceLock is null)
        {
            log.LogError("Bu veri dizini ({DataDir}) icin baska bir sysmon ornegi calisiyor; kilit alinamadi. Agent durduruluyor.", dataDir);
            Environment.ExitCode = 1;
            lifetime.StopApplication();
            return;
        }

        var spool = new Spool(AgentPaths.SpoolDir(options),
            new SpoolLimits(MaxBytes: 50L * 1024 * 1024, MaxAge: TimeSpan.FromHours(24), SegmentBytes: 1024 * 1024),
            () => DateTimeOffset.UtcNow,
            onDropped: n => log.LogWarning("Spool boyutu veya yas siniri asildi: {Count} eski batch atildi.", n));

        using var cpu = new PdhCpuSource();
        var runner = new CollectorRunner(
        [
            new CpuCollector(cpu),
            new MemoryCollector(new WindowsMemoryInfoSource()),
            new DiskCollector(new SystemDriveSource()),
            new NetworkCollector(new SystemNetworkSource(), () => Environment.TickCount64),
        ], TimeSpan.FromSeconds(2));

        SamplingPipeline? pipeline = null;
        Uploader? uploader = null;
        var loss = new LossReporter(
            () => new LossCounters(pipeline?.DroppedSamples ?? 0, uploader?.RejectedSamples ?? 0, spool.DroppedBatches),
            msg => log.LogWarning("{Message}", msg),
            (ex, suppressed) => log.LogError(ex,
                "Ornekler spool'a yazilamadi (tamponda tutuluyor, yeniden denenecek); son aralikta {Suppressed} benzer hata bastirildi.", suppressed),
            () => DateTimeOffset.UtcNow, TimeSpan.FromSeconds(60));

        pipeline = new SamplingPipeline(runner, spool, () => DateTimeOffset.UtcNow, SampleInterval, BatchInterval,
            onStatusChange: st =>
            {
                if (st.Ok) log.LogInformation("Collector {Name} duzeldi.", st.Name);
                else log.LogWarning("Collector {Name} calismiyor: {Message}", st.Name, st.Message);
            },
            onError: loss.ReportError);
        var tasks = new List<Task> { pipeline.RunAsync(stoppingToken), LossLoop(loss, stoppingToken) };

        if (options.Server is not null)
        {
            var store = new TokenStore(AgentPaths.TokenStorePath(options));
            // Token gecidi kaldirildi: baslangicta token olmasa bile yukleme dongusu baslatilir;
            // token daha sonra aktarildiginda veya degistiginde (401/403 5 dk aralikla denenirken)
            // servis yeniden baslatilmadan toparlanir.
            uploader = new Uploader(spool, HttpClients.Create(options.ServerPins), new Uri(options.Server),
                () => ReadToken(store),
                options, () => DateTimeOffset.UtcNow);

            uploader.BatchDropped += (batch, status) =>
                log.LogWarning("Zehirli batch atildi: seq {Seq}, durum {Status}. Yalnizca bu batch kuyruktan cikarildi.", batch.Seq, status);

            log.LogInformation("Yukleme etkin: sunucu {Server}, SPKI pin sayisi {Pins}.",
                options.Server, options.ServerPins?.Count ?? 0);
            tasks.Add(UploadLoop(uploader, stoppingToken));
        }
        else
        {
            log.LogWarning("--server verilmedi: yukleme kapali, ornekler yalnizca yerel spool'a yaziliyor.");
        }

        await Task.WhenAll(tasks);
    }

    /// <summary>Kayip sayaclarini periyodik kontrol eder; degisim varsa kumulatif degerlerle bir uyari yazar.</summary>
    private static async Task LossLoop(LossReporter loss, CancellationToken ct)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(60));
        try
        {
            while (await timer.WaitForNextTickAsync(ct)) loss.CheckCounters();
        }
        catch (OperationCanceledException) { /* normal kapanis */ }
        loss.CheckCounters();
    }

    [System.Runtime.Versioning.SupportedOSPlatform("windows")]
    private static string ReadToken(TokenStore store) =>
        store.TryLoad(out var t) ? t! : "";

    private async Task UploadLoop(Uploader uploader, CancellationToken ct)
    {
        var runner = new UploadRunner(uploader.UploadOnceAsync, Task.Delay, new Random(),
            onWait: (outcome, wait) =>
            {
                if (outcome == UploadOutcome.TlsRejected)
                    log.LogError("Sunucu sertifikasi dogrulanamadi (SPKI pin / sertifika); veri ve token gonderilmedi. {Wait:0} sn sonra yeniden denenecek.", wait.TotalSeconds);
                else if (outcome == UploadOutcome.AuthFailed)
                    log.LogWarning("Sunucu kimlik bilgisini reddetti (401/403). {Wait:0} sn sonra yeniden denenecek; token guncellenirse yukleme devam eder.", wait.TotalSeconds);
                else if (outcome == UploadOutcome.Retry)
                    log.LogWarning("Yukleme basarisiz, {Wait:0.0} sn sonra yeniden denenecek.", wait.TotalSeconds);
            },
            onUnexpected: ex => log.LogError(ex, "Yukleme adiminda beklenmeyen hata; yeniden denenecek."));

        await runner.RunAsync(ct);
    }
}
