using SysMon.Agent.Collectors;
using SysMon.Agent.Hardware;
using SysMon.Agent.Sensors;

namespace Agent.Tests.Hardware;

public class GpuCollectorTests
{
    private const string Id = "gpu-46139694-b075-6c98-9b95-3b6f3a465823";
    private static GpuDevice Dev(string id = Id, string provider = "fake") => new(id, "NVIDIA", "RTX", provider);

    private sealed class Clock
    {
        private DateTimeOffset _t = new(2026, 11, 17, 12, 0, 0, TimeSpan.Zero);
        public DateTimeOffset Now() => _t;
        public void Advance(double sec) => _t += TimeSpan.FromSeconds(sec);
    }

    private static GpuCollector Make(Clock c, params IGpuProvider[] providers) =>
        new(providers, TimeSpan.FromSeconds(5), TimeSpan.FromSeconds(1), TimeSpan.FromSeconds(60), c.Now);

    private static readonly GpuSample Full = new(UtilPct: 40, VramUsedBytes: 1000, VramTotalBytes: 8000, TempC: 55, PowerW: 90.5, FanPct: 30, CoreClockMHz: 1800, MemClockMHz: 9000);

    [Fact]
    public async Task Tum_alanlar_CanonicalId_anahtarli_metrik_adlariyla_yayinlanir_ve_adlar_gecerlidir()
    {
        var p = new FakeGpuProvider("fake", 1, [Dev()]) { Sample = Full };
        var m = await Make(new Clock(), p).CollectAsync(CancellationToken.None);

        Assert.Equal(40, m[$"gpu.{Id}.util_pct"]);
        Assert.Equal(1000, m[$"gpu.{Id}.vram_used_bytes"]);
        Assert.Equal(8000, m[$"gpu.{Id}.vram_total_bytes"]);
        Assert.Equal(55, m[$"gpu.{Id}.temp_c"]);
        Assert.Equal(90.5, m[$"gpu.{Id}.power_w"]);
        Assert.Equal(30, m[$"gpu.{Id}.fan_pct"]);
        Assert.Equal(1800, m[$"gpu.{Id}.core_clock_mhz"]);
        Assert.Equal(9000, m[$"gpu.{Id}.mem_clock_mhz"]);
        Assert.Equal(8, m.Count);
        Assert.All(m.Keys, k => Assert.True(MetricNames.IsValid(k), k));
    }

    [Fact]
    public async Task Desteklenmeyen_yetenek_icin_metrik_hic_yayinlanmaz_desteklenip_okunamayan_null_olur()
    {
        var p = new FakeGpuProvider("fake", 1, [Dev()])
        {
            Caps = GpuCapabilities.Utilization | GpuCapabilities.Temperature,
            Sample = new GpuSample(UtilPct: 10, TempC: null), // sicaklik destekli ama bu orneklemede okunamadi
        };
        var m = await Make(new Clock(), p).CollectAsync(CancellationToken.None);
        Assert.Equal(2, m.Count);
        Assert.Equal(10, m[$"gpu.{Id}.util_pct"]);
        Assert.True(m.ContainsKey($"gpu.{Id}.temp_c"));
        Assert.Null(m[$"gpu.{Id}.temp_c"]);
    }

    [Fact]
    public async Task Kullanilamayan_saglayici_bos_sonuc_verir_ve_firlatmaz()
    {
        var p = new FakeGpuProvider("fake", 1, [Dev()]) { Available = false };
        var m = await Make(new Clock(), p).CollectAsync(CancellationToken.None);
        Assert.Empty(m);
    }

    [Fact]
    public async Task Ayni_GPU_iki_saglayicida_gelirse_oncelikli_saglayicinin_degerleri_kullanilir()
    {
        var low = new FakeGpuProvider("pdh", 10, [Dev(provider: "pdh")]) { Sample = new GpuSample(UtilPct: 1) };
        var high = new FakeGpuProvider("nvml", 100, [Dev(provider: "nvml")]) { Sample = new GpuSample(UtilPct: 99) };
        var m = await Make(new Clock(), low, high).CollectAsync(CancellationToken.None);
        Assert.Equal(99, m[$"gpu.{Id}.util_pct"]);
    }

    [Fact]
    public async Task Okuma_hatasi_ve_zaman_asiminda_yetenek_metrikleri_null_olur_collector_firlatmaz()
    {
        var failing = new FakeGpuProvider("fake", 1, [Dev()]) { ThrowOnRead = new InvalidOperationException("GPU_IS_LOST"), Caps = GpuCapabilities.Utilization | GpuCapabilities.Vram };
        var m = await Make(new Clock(), failing).CollectAsync(CancellationToken.None);
        Assert.Equal(3, m.Count); // util + vram_used + vram_total
        Assert.All(m.Values, v => Assert.Null(v));

        var hung = new FakeGpuProvider("fake", 1, [Dev()]) { BlockForever = true, IgnoreToken = true, Caps = GpuCapabilities.Utilization };
        var sw = System.Diagnostics.Stopwatch.StartNew();
        var m2 = await Make(new Clock(), hung).CollectAsync(CancellationToken.None);
        Assert.Null(Assert.Single(m2).Value);
        Assert.True(sw.Elapsed < TimeSpan.FromSeconds(10));
    }

    [Fact]
    public async Task Kayip_sonrasi_hemen_yeniden_kesfeder_baslangicta_GPU_yoksa_periyodik_arar()
    {
        var c = new Clock();
        var p = new FakeGpuProvider("fake", 1, [Dev()]) { Available = false, Sample = Full };
        var col = Make(c, p);
        Assert.Empty(await col.CollectAsync(CancellationToken.None));

        p.Available = true;                                  // surucu sonradan geldi
        Assert.Empty(await col.CollectAsync(CancellationToken.None));   // yeniden kesif araligi (60 sn) dolmadi
        c.Advance(61);
        Assert.NotEmpty(await col.CollectAsync(CancellationToken.None));

        var before = p.DiscoverCalls;
        p.ThrowOnRead = new InvalidOperationException("lost");   // okuma basarisiz -> bir sonraki turda hemen yeniden kesif
        await col.CollectAsync(CancellationToken.None);
        Assert.Equal(before, p.DiscoverCalls);                  // ayni turda kesif yok
        p.ThrowOnRead = null;
        Assert.Equal(40, (await col.CollectAsync(CancellationToken.None))[$"gpu.{Id}.util_pct"]);
        Assert.Equal(before + 1, p.DiscoverCalls);              // kayip sonrasi sonraki turda HEMEN yeniden kesfetti (60 sn beklemedi)
    }

    [Fact]
    public async Task Yeniden_kesif_araligi_TAM_dolunca_kesfeder_bir_tik_oncesinde_degil()
    {
        var c = new Clock();
        var p = new FakeGpuProvider("fake", 1, [Dev()]) { Sample = Full };
        var col = Make(c, p);
        await col.CollectAsync(CancellationToken.None);
        var calls = p.DiscoverCalls;
        c.Advance(59.999);
        await col.CollectAsync(CancellationToken.None);
        Assert.Equal(calls, p.DiscoverCalls);
        c.Advance(0.001);
        await col.CollectAsync(CancellationToken.None);
        Assert.Equal(calls + 1, p.DiscoverCalls);
    }

    [Fact]
    public async Task Kesif_gecici_hata_Busy_verirse_onceki_cihaz_listesi_korunur_ve_hemen_yeniden_denenir()
    {
        var c = new Clock();
        var p = new FakeGpuProvider("fake", 1, [Dev()]) { Sample = Full };
        var col = Make(c, p);
        Assert.NotEmpty(await col.CollectAsync(CancellationToken.None));

        p.ThrowOnDiscover = new GpuProviderBusyException();
        c.Advance(61);                                            // periyodik kesif zamani
        Assert.NotEmpty(await col.CollectAsync(CancellationToken.None));   // liste SILINMEDI: metrikler akmaya devam eder

        var calls = p.DiscoverCalls;
        p.ThrowOnDiscover = null;
        Assert.NotEmpty(await col.CollectAsync(CancellationToken.None));
        Assert.Equal(calls + 1, p.DiscoverCalls);                 // basarisiz kesif sonrasi sonraki turda (60 sn beklemeden) yeniden denendi
    }

    [Fact]
    public async Task Gecersiz_CanonicalId_li_cihaz_metrik_uretmez()
    {
        var p = new FakeGpuProvider("fake", 1, [Dev("luid_0x1_phys_0")]) { Sample = Full };
        Assert.Empty(await Make(new Clock(), p).CollectAsync(CancellationToken.None));
    }

    [Fact]
    public void Ad_aralik_ve_kimlik_ozellikleri()
    {
        var col = Make(new Clock());
        Assert.Equal("gpu", col.Name);
        Assert.Equal(TimeSpan.FromSeconds(5), col.Interval);
    }
}

public class SensorCollectorTests
{
    [Fact]
    public async Task Yalniz_Ok_okumalar_sensor_metrigi_olarak_yayinlanir_diger_durumlar_atlanir()
    {
        Task<IReadOnlyList<SensorReading>> Read(CancellationToken _) => Task.FromResult<IReadOnlyList<SensorReading>>(
        [
            new(SensorId.CpuPackageTempC, SensorStatus.Ok, 61.5),
            new(SensorId.CpuCoreMaxTempC, SensorStatus.Unavailable, 0),
            new(SensorId.MotherboardTempC, SensorStatus.PermissionDenied, 0),
            new(SensorId.CpuFanRpm, SensorStatus.ProviderError, 0),
        ]);
        var m = await new SensorCollector(Read, TimeSpan.FromSeconds(5)).CollectAsync(CancellationToken.None);
        Assert.Equal(61.5, Assert.Single(m).Value);
        Assert.Equal("sensor.cpu_package_temp_c", Assert.Single(m).Key);
    }

    [Fact]
    public async Task Tum_sensor_adlari_gecerli_ve_benzersizdir()
    {
        Task<IReadOnlyList<SensorReading>> Read(CancellationToken _) => Task.FromResult<IReadOnlyList<SensorReading>>(
            Enum.GetValues<SensorId>().Select(id => new SensorReading(id, SensorStatus.Ok, 10)).ToList());
        var m = await new SensorCollector(Read, TimeSpan.FromSeconds(5)).CollectAsync(CancellationToken.None);
        Assert.Equal(Enum.GetValues<SensorId>().Length, m.Count);
        Assert.All(m.Keys, k => Assert.True(MetricNames.IsValid(k), k));
    }

    [Fact]
    public async Task Okuyucu_firlatirsa_bos_sonuc_doner_collector_firlatmaz()
    {
        Task<IReadOnlyList<SensorReading>> Read(CancellationToken _) => throw new InvalidOperationException("x");
        Assert.Empty(await new SensorCollector(Read, TimeSpan.FromSeconds(5)).CollectAsync(CancellationToken.None));
    }

    [Fact]
    public async Task Iptal_yayilir()
    {
        Task<IReadOnlyList<SensorReading>> Read(CancellationToken ct) { ct.ThrowIfCancellationRequested(); return Task.FromResult<IReadOnlyList<SensorReading>>([]); }
        using var cts = new CancellationTokenSource();
        cts.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => new SensorCollector(Read, TimeSpan.FromSeconds(5)).CollectAsync(cts.Token));
    }
}
