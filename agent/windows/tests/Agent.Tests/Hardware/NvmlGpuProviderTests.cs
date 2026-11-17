using SysMon.Agent.Hardware;
using SysMon.Agent.Hardware.Nvml;

namespace Agent.Tests.Hardware;

public class NvmlGpuProviderTests
{
    private const string Uuid = "GPU-46139694-b075-6c98-9b95-3b6f3a465823";
    private const string CanonId = "gpu-46139694-b075-6c98-9b95-3b6f3a465823";

    private static (NvmlGpuProvider P, FakeNvmlApi Api, FakeClock Clock) Make(params FakeNvmlGpu[] gpus)
    {
        var api = new FakeNvmlApi();
        api.Gpus.AddRange(gpus);
        var clock = new FakeClock();
        return (new NvmlGpuProvider(api, clock.Now), api, clock);
    }

    private sealed class FakeClock
    {
        private DateTimeOffset _t = new(2026, 11, 17, 12, 0, 0, TimeSpan.Zero);
        public DateTimeOffset Now() => _t;
        public void Advance(TimeSpan d) => _t += d;
    }

    private static async Task<(GpuDevice Dev, GpuSample S)> DiscoverAndRead(NvmlGpuProvider p)
    {
        var devs = await p.DiscoverAsync(CancellationToken.None);
        var d = Assert.Single(devs);
        return (d, await p.ReadAsync(d, CancellationToken.None));
    }

    // ---------- kesif ----------

    [Fact]
    public async Task Kesif_UUID_den_CanonicalId_ad_satici_ve_saglayici_kimligini_uretir()
    {
        var (p, _, _) = Make(new FakeNvmlGpu { Uuid = Uuid, Name = "RTX Test" });
        var d = Assert.Single(await p.DiscoverAsync(CancellationToken.None));
        Assert.Equal(CanonId, d.CanonicalId);
        Assert.Equal("RTX Test", d.Name);
        Assert.Equal("NVIDIA", d.Vendor);
        Assert.Equal("nvml", d.ProviderId);
        Assert.Equal("nvml", p.Id);
        Assert.True(p.Priority >= 100);
    }

    [Fact]
    public async Task Gecersiz_UUID_li_cihaz_atlanir_digerleri_kalir()
    {
        var (p, _, _) = Make(new FakeNvmlGpu { Uuid = "MIG-bozuk" }, new FakeNvmlGpu { Uuid = Uuid });
        var d = Assert.Single(await p.DiscoverAsync(CancellationToken.None));
        Assert.Equal(CanonId, d.CanonicalId);
    }

    // ---------- baslatma / kaynak yonetimi ----------

    [Theory]
    [InlineData(NvmlStatus.LibraryNotFound)]
    [InlineData(NvmlStatus.FunctionNotFound)]
    [InlineData(NvmlStatus.DriverNotLoaded)]
    [InlineData(NvmlStatus.Unknown)]
    public async Task Init_hatasi_saglayiciyi_kullanilamaz_yapar_firlatmaz_ve_Shutdown_cagrilmaz(NvmlStatus st)
    {
        var (p, api, _) = Make(new FakeNvmlGpu());
        api.InitStatus = st;
        Assert.False(p.IsAvailable());
        Assert.Empty(await p.DiscoverAsync(CancellationToken.None));
        p.Dispose();
        Assert.Equal(0, api.ShutdownCalls);
    }

    [Fact]
    public async Task Shutdown_yalniz_basarili_Init_icin_ve_tam_bir_kez_cagrilir_cift_Dispose_guvenli()
    {
        var (p, api, _) = Make(new FakeNvmlGpu());
        await p.DiscoverAsync(CancellationToken.None);
        p.Dispose();
        p.Dispose();
        Assert.Equal(1, api.InitCalls);
        Assert.Equal(1, api.ShutdownCalls);
        Assert.Equal(0, api.LiveInits);
    }

    [Fact]
    public async Task Dispose_sonrasi_saglayici_kullanilamaz_ve_firlatmaz()
    {
        var (p, api, _) = Make(new FakeNvmlGpu());
        await p.DiscoverAsync(CancellationToken.None);
        p.Dispose();
        Assert.False(p.IsAvailable());
        Assert.Empty(await p.DiscoverAsync(CancellationToken.None));
        Assert.Equal(1, api.InitCalls); // Dispose sonrasi yeniden Init yok
    }

    // ---------- NOT_SUPPORTED / null anlami / gercek sifir ----------

    [Fact]
    public async Task NotSupported_alan_null_olur_ve_yetenek_bayragi_yoktur_digerleri_doludur()
    {
        var (p, _, _) = Make(new FakeNvmlGpu { FanStatus = NvmlStatus.NotSupported, PowerStatus = NvmlStatus.NotSupported });
        var (d, s) = await DiscoverAndRead(p);
        Assert.Null(s.FanPct);
        Assert.Null(s.PowerW);
        Assert.Equal(40, s.UtilPct);
        Assert.Equal(55, s.TempC);
        var caps = p.Capabilities(d);
        Assert.False(caps.HasFlag(GpuCapabilities.Fan));
        Assert.False(caps.HasFlag(GpuCapabilities.Power));
        Assert.True(caps.HasFlag(GpuCapabilities.Utilization));
        Assert.True(caps.HasFlag(GpuCapabilities.Vram));
    }

    [Fact]
    public async Task Gercek_sifir_degerler_null_ile_karismaz()
    {
        var (p, _, _) = Make(new FakeNvmlGpu { Util = 0, FanPct = 0, PowerMw = 0, Used = 0 });
        var (_, s) = await DiscoverAndRead(p);
        Assert.Equal(0.0, s.UtilPct);
        Assert.Equal(0.0, s.FanPct);
        Assert.Equal(0.0, s.PowerW);
        Assert.Equal(0L, s.VramUsedBytes);
    }

    [Fact]
    public async Task Tek_alan_beklenmedik_hata_verirse_yalniz_o_alan_null_olur_ornek_gecerli_kalir()
    {
        var (p, _, _) = Make(new FakeNvmlGpu { TempStatus = NvmlStatus.Unknown });
        var (_, s) = await DiscoverAndRead(p);
        Assert.Null(s.TempC);
        Assert.Equal(40, s.UtilPct);
        Assert.NotNull(s.VramTotalBytes);
    }

    // ---------- birim donusumu ve dogrulama ----------

    [Fact]
    public async Task Birimler_protokol_birimine_tek_yerde_cevrilir()
    {
        var (p, _, _) = Make(new FakeNvmlGpu { PowerMw = 123_456, Total = 12_227UL << 20, Used = 1_443UL << 20, CoreMHz = 2505, MemMHz = 14001 });
        var (_, s) = await DiscoverAndRead(p);
        Assert.Equal(123.456, s.PowerW!.Value, 3);        // mW -> W
        Assert.Equal(12_227L << 20, s.VramTotalBytes);     // bayt
        Assert.Equal(1_443L << 20, s.VramUsedBytes);
        Assert.Equal(2505, s.CoreClockMHz);
        Assert.Equal(14001, s.MemClockMHz);
    }

    [Fact]
    public async Task Aralik_disi_degerler_sessizce_duzeltilmez_alan_null_olur()
    {
        var (p, _, _) = Make(new FakeNvmlGpu { Util = 150, FanPct = 250, TempC = 5000, CoreMHz = 4_000_000_000 });
        var (_, s) = await DiscoverAndRead(p);
        Assert.Null(s.UtilPct);
        Assert.Null(s.FanPct);
        Assert.Null(s.TempC);
        Assert.Null(s.CoreClockMHz);
        Assert.NotNull(s.VramTotalBytes);
    }

    [Fact]
    public async Task Kullanilan_VRAM_toplami_asarsa_kullanilan_null_olur()
    {
        var (p, _, _) = Make(new FakeNvmlGpu { Total = 1000, Used = 2000 });
        var (_, s) = await DiscoverAndRead(p);
        Assert.Null(s.VramUsedBytes);
        Assert.Equal(1000L, s.VramTotalBytes);
    }

    [Fact]
    public async Task Long_siniri_asan_VRAM_degeri_null_olur_tasma_yok()
    {
        var (p, _, _) = Make(new FakeNvmlGpu { Total = ulong.MaxValue, Used = 5 });
        var (_, s) = await DiscoverAndRead(p);
        Assert.Null(s.VramTotalBytes);
        Assert.Null(s.VramUsedBytes); // toplam yoksa tutarlilik icin kullanilan da yayinlanmaz
    }

    // ---------- GPU kaybi / yeniden baslatma ----------

    [Fact]
    public async Task GPU_okuma_sirasinda_kaybolursa_GpuLostException_ve_kismi_veri_yok_Shutdown_yapilir()
    {
        var (p, api, _) = Make(new FakeNvmlGpu());
        var devs = await p.DiscoverAsync(CancellationToken.None);
        api.Lost = true;
        await Assert.ThrowsAsync<GpuLostException>(() => p.ReadAsync(devs[0], CancellationToken.None));
        Assert.Equal(1, api.ShutdownCalls);
        Assert.Equal(0, api.LiveInits);
    }

    [Fact]
    public async Task Kayiptan_sonra_surucu_donerse_yeniden_Init_ile_toparlanir()
    {
        var (p, api, _) = Make(new FakeNvmlGpu());
        var devs = await p.DiscoverAsync(CancellationToken.None);
        api.Lost = true;
        await Assert.ThrowsAsync<GpuLostException>(() => p.ReadAsync(devs[0], CancellationToken.None));
        api.Lost = false;

        Assert.True(p.IsAvailable());
        var (_, s) = await DiscoverAndRead(p);
        Assert.Equal(40, s.UtilPct);
        Assert.Equal(2, api.InitCalls);
        p.Dispose();
        Assert.Equal(0, api.LiveInits); // Init/Shutdown dengeli
    }

    [Fact]
    public async Task Eski_tutamakla_okuma_kayip_sonrasi_yeniden_kesif_olmadan_GpuLostException_verir()
    {
        var (p, api, _) = Make(new FakeNvmlGpu());
        var devs = await p.DiscoverAsync(CancellationToken.None);
        api.Lost = true;
        await Assert.ThrowsAsync<GpuLostException>(() => p.ReadAsync(devs[0], CancellationToken.None));
        api.Lost = false;
        // yeniden kesif yapilmadi: eski tutamak gecersiz sayilir, eskimis veri yayinlanmaz
        await Assert.ThrowsAsync<GpuLostException>(() => p.ReadAsync(devs[0], CancellationToken.None));
    }

    [Fact]
    public async Task Devre_kesici_ardisik_init_hatalarinda_sinirsiz_denemez_ve_bekleme_sonrasi_tek_deneme_yapar()
    {
        var (p, api, clock) = Make(new FakeNvmlGpu());
        api.InitStatus = NvmlStatus.DriverNotLoaded;

        for (var i = 0; i < 10; i++) Assert.False(p.IsAvailable());
        Assert.Equal(3, api.InitCalls); // MaxInitFailures

        clock.Advance(TimeSpan.FromMinutes(6));
        Assert.False(p.IsAvailable());
        Assert.False(p.IsAvailable());
        Assert.Equal(4, api.InitCalls); // yarim acik: yalniz TEK deneme

        api.InitStatus = NvmlStatus.Success;
        clock.Advance(TimeSpan.FromMinutes(6));
        Assert.True(p.IsAvailable());   // surucu geldi: toparlandi
    }

    [Fact]
    public async Task Tekrarlayan_GPU_kayiplari_da_devre_kesiciyi_acar()
    {
        var (p, api, _) = Make(new FakeNvmlGpu());
        for (var i = 0; i < 3; i++)
        {
            Assert.True(p.IsAvailable());
            var devs = await p.DiscoverAsync(CancellationToken.None);
            api.Lost = true;
            await Assert.ThrowsAsync<GpuLostException>(() => p.ReadAsync(devs[0], CancellationToken.None));
            api.Lost = false;
        }
        Assert.Equal(3, api.InitCalls);
        Assert.False(p.IsAvailable());
        Assert.Equal(3, api.InitCalls); // kesici acik: yeni Init yok
    }

    [Fact]
    public async Task Araya_basarili_okuma_giren_aralikli_kayiplar_devre_kesiciyi_acmaz()
    {
        var (p, api, _) = Make(new FakeNvmlGpu());
        for (var i = 0; i < 5; i++)
        {
            Assert.True(p.IsAvailable());
            var devs = await p.DiscoverAsync(CancellationToken.None);
            Assert.Equal(40, (await p.ReadAsync(devs[0], CancellationToken.None)).UtilPct); // saglikli okuma sayaci sifirlar
            api.Lost = true;
            await Assert.ThrowsAsync<GpuLostException>(() => p.ReadAsync(devs[0], CancellationToken.None));
            api.Lost = false;
        }
        Assert.True(p.IsAvailable()); // ardisik degil: kesici kapali
        Assert.Equal(6, api.InitCalls);
    }

    // ---------- bloklayan native cagri ----------

    [Fact]
    public async Task Bloklu_okuma_surerken_yeni_okumalar_birikmez_hizla_Busy_ile_reddedilir_IsAvailable_bloklanmaz()
    {
        var (p, api, _) = Make(new FakeNvmlGpu());
        var devs = await p.DiscoverAsync(CancellationToken.None);
        using var entered = new ManualResetEventSlim();
        using var release = new ManualResetEventSlim();
        api.BeforeUtilization = () => { entered.Set(); release.Wait(TimeSpan.FromSeconds(10)); };

        var first = Task.Run(() => p.ReadAsync(devs[0], CancellationToken.None));
        Assert.True(entered.Wait(TimeSpan.FromSeconds(5)), "ilk okuma native cagriya girmedi");
        api.BeforeUtilization = null;

        var sw = System.Diagnostics.Stopwatch.StartNew();
        await Assert.ThrowsAsync<GpuProviderBusyException>(() => p.ReadAsync(devs[0], CancellationToken.None));
        Assert.True(p.IsAvailable());
        Assert.True(sw.Elapsed < TimeSpan.FromSeconds(5), $"yeni cagrilar bloklandi: {sw.Elapsed}");

        release.Set();
        Assert.Equal(40, (await first).UtilPct);
        // blok bitince normale doner
        Assert.Equal(40, (await p.ReadAsync(devs[0], CancellationToken.None)).UtilPct);
    }

    [Fact]
    public async Task GpuReader_bloklu_native_cagri_icin_TimedOut_doner_sonraki_okuma_Failed_Busy()
    {
        var (p, api, _) = Make(new FakeNvmlGpu());
        var devs = await p.DiscoverAsync(CancellationToken.None);
        using var release = new ManualResetEventSlim();
        api.BeforeUtilization = () => release.Wait(TimeSpan.FromSeconds(10));

        var r1 = await GpuReader.ReadAsync(p, devs[0], TimeSpan.FromMilliseconds(150), CancellationToken.None);
        Assert.Equal(GpuReadStatus.TimedOut, r1.Status);
        api.BeforeUtilization = null;
        var r2 = await GpuReader.ReadAsync(p, devs[0], TimeSpan.FromMilliseconds(500), CancellationToken.None);
        Assert.Equal(GpuReadStatus.Failed, r2.Status); // takili native cagri uzerine ikinci cagri yigilmaz
        release.Set();
    }

    [Fact]
    public async Task Iptal_edilmis_token_native_cagriya_girmeden_OperationCanceledException_verir()
    {
        var (p, api, _) = Make(new FakeNvmlGpu());
        var devs = await p.DiscoverAsync(CancellationToken.None);
        var calls = 0;
        api.BeforeUtilization = () => calls++;
        using var cts = new CancellationTokenSource();
        cts.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => p.ReadAsync(devs[0], cts.Token));
        Assert.Equal(0, calls);
    }
}

public class NvmlGpuProviderConformanceTests : GpuProviderConformanceTests
{
    protected override IGpuProvider Create()
    {
        var api = new FakeNvmlApi();
        api.Gpus.Add(new FakeNvmlGpu());
        return new NvmlGpuProvider(api);
    }
}

public class NvmlGpuProviderUnavailableConformanceTests : GpuProviderConformanceTests
{
    protected override IGpuProvider Create()
    {
        var api = new FakeNvmlApi { InitStatus = NvmlStatus.LibraryNotFound };
        api.Gpus.Add(new FakeNvmlGpu());
        return new NvmlGpuProvider(api);
    }
}
