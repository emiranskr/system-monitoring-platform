using SysMon.Agent.Sensors;

namespace Agent.Tests.Sensors;

public class SensorHalTests
{
    [Fact]
    public async Task NullSensorProvider_tum_bilinen_sensorleri_Unavailable_doner()
    {
        var r = await new NullSensorProvider().ReadAllAsync(CancellationToken.None);
        Assert.Equal(Enum.GetValues<SensorId>().Length, r.Count);
        Assert.All(r, x => { Assert.Equal(SensorStatus.Unavailable, x.Status); Assert.Equal(0.0, x.Value); });
        Assert.Equal(r.Count, r.Select(x => x.Id).Distinct().Count());
    }

    [Theory]
    [InlineData(SensorId.CpuPackageTempC, -50, 200)]
    [InlineData(SensorId.CpuFanRpm, 0, 100_000)]
    public void Sensor_basina_birim_araligi_tanimli(SensorId id, double min, double max)
    {
        Assert.True(SensorSpec.TryGet(id, out var spec));
        Assert.Equal(min, spec.Min);
        Assert.Equal(max, spec.Max);
    }

    [Fact]
    public void Bilinmeyen_sensor_kimligi_taniminda_yok()
    {
        Assert.False(SensorSpec.TryGet((SensorId)200, out _));
    }

    [Fact]
    public void Her_bilinen_sensorun_birimi_ve_araligi_vardir()
    {
        foreach (var id in Enum.GetValues<SensorId>())
        {
            Assert.True(SensorSpec.TryGet(id, out var s), id.ToString());
            Assert.False(string.IsNullOrEmpty(s.Unit));
            Assert.True(s.Min < s.Max);
        }
    }
}

public class SensorProtocolTests
{
    private static SensorReading Ok(SensorId id, double v) => new(id, SensorStatus.Ok, v);
    private static SensorReading Bad(SensorId id, SensorStatus s) => new(id, s, 0.0);

    private static byte[] Payload(params byte[][] parts) => parts.SelectMany(p => p).ToArray();
    private static byte[] Entry(byte id, byte status, double v) => [id, status, .. BitConverter.GetBytes(v)];
    private static byte[] Msg(byte[] payload) => [.. BitConverter.GetBytes((uint)payload.Length), .. payload];

    private static Task<IReadOnlyList<SensorReading>> Read(byte[] bytes, Stream? wrap = null) =>
        SensorProtocol.ReadResponseAsync(wrap ?? new MemoryStream(bytes), CancellationToken.None);

    private static async Task<SensorProtocolException> Rejects(byte[] bytes) =>
        await Assert.ThrowsAsync<SensorProtocolException>(() => Read(bytes));

    /// <summary>Her okuma en cok 1 bayt dondurur (ag/pipe parcalanmasi).</summary>
    private sealed class OneByteStream(byte[] data) : MemoryStream(data)
    {
        public override int Read(byte[] buffer, int offset, int count) => base.Read(buffer, offset, Math.Min(1, count));
        public override ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken ct = default) => base.ReadAsync(buffer[..Math.Min(1, buffer.Length)], ct);
    }

    // ---------- kodlama ----------

    [Fact]
    public async Task Gidis_donus_okumalari_korur()
    {
        var input = new[] { Ok(SensorId.CpuPackageTempC, 36.5), Bad(SensorId.CpuFanRpm, SensorStatus.Unsupported), Bad(SensorId.MotherboardTempC, SensorStatus.PermissionDenied) };
        var output = await Read(SensorProtocol.EncodeResponse(input));
        Assert.Equal(input, output);
    }

    [Fact]
    public void Bayt_duzeni_little_endian_ve_sabit_sema()
    {
        var bytes = SensorProtocol.EncodeResponse([Ok(SensorId.CpuPackageTempC, 36.5)]);
        // uzunluk(u32 LE)=12 | surum=1 | sayi=1 | id=1 | durum=0 | 36.5 (f64 LE)
        Assert.Equal(new byte[] { 12, 0, 0, 0, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0x40, 0x42, 0x40 }, bytes);
    }

    [Fact]
    public void Istek_iki_bayt_surum_ve_opcode()
    {
        Assert.Equal(new byte[] { 1, 1 }, SensorProtocol.EncodeRequest());
    }

    [Fact]
    public void Kodlayici_gecersiz_okumalari_reddeder()
    {
        Assert.Throws<ArgumentException>(() => SensorProtocol.EncodeResponse([Ok(SensorId.CpuPackageTempC, double.NaN)]));
        Assert.Throws<ArgumentException>(() => SensorProtocol.EncodeResponse([Ok(SensorId.CpuPackageTempC, 1), Ok(SensorId.CpuPackageTempC, 2)]));
        Assert.Throws<ArgumentException>(() => SensorProtocol.EncodeResponse([Ok(SensorId.CpuPackageTempC, 999)]));
        Assert.Throws<ArgumentException>(() => SensorProtocol.EncodeResponse([new SensorReading((SensorId)200, SensorStatus.Ok, 1)]));
    }

    // ---------- istek ----------

    [Fact]
    public async Task Gecerli_istek_okunur_ve_bozuk_istek_reddedilir()
    {
        await SensorProtocol.ReadRequestAsync(new MemoryStream([1, 1]), CancellationToken.None);
        await Assert.ThrowsAsync<SensorProtocolException>(() => SensorProtocol.ReadRequestAsync(new MemoryStream([2, 1]), CancellationToken.None));   // surum
        await Assert.ThrowsAsync<SensorProtocolException>(() => SensorProtocol.ReadRequestAsync(new MemoryStream([1, 9]), CancellationToken.None));   // opcode
        var trunc = await Assert.ThrowsAsync<SensorProtocolException>(() => SensorProtocol.ReadRequestAsync(new MemoryStream([1]), CancellationToken.None));
        Assert.Equal(SensorProtocolError.Truncated, trunc.Error);
    }

    // ---------- sinirlar ve bozuk mesajlar ----------

    [Fact]
    public async Task Uzunluk_siniri_ustu_yanit_govde_okunmadan_ve_bellek_ayrilmadan_reddedilir()
    {
        // 4 KiB + 1 uzunluk bildirir; govde YOK. Okuyucu govdeyi okumaya/ayirmaya calissaydi 'Truncated' olurdu.
        var ex = await Rejects(BitConverter.GetBytes((uint)SensorProtocol.MaxPayloadBytes + 1));
        Assert.Equal(SensorProtocolError.TooLarge, ex.Error);
        var huge = await Rejects(BitConverter.GetBytes(uint.MaxValue));
        Assert.Equal(SensorProtocolError.TooLarge, huge.Error);
    }

    [Fact]
    public async Task Kesik_uzunluk_ve_kesik_govde_Truncated_olur()
    {
        Assert.Equal(SensorProtocolError.Truncated, (await Rejects([12, 0])).Error);
        var full = SensorProtocol.EncodeResponse([Ok(SensorId.CpuPackageTempC, 40)]);
        Assert.Equal(SensorProtocolError.Truncated, (await Rejects(full[..^3])).Error);
    }

    [Fact]
    public async Task Parcali_okuma_bir_bayt_bir_bayt_dogru_cozulur()
    {
        var input = new[] { Ok(SensorId.CpuPackageTempC, 41.25), Bad(SensorId.CpuFanRpm, SensorStatus.ProviderError) };
        var bytes = SensorProtocol.EncodeResponse(input);
        Assert.Equal(input, await Read(bytes, new OneByteStream(bytes)));
    }

    [Fact]
    public async Task Tek_okumada_gelen_birden_fazla_mesaj_siralı_ayrisir()
    {
        var a = SensorProtocol.EncodeResponse([Ok(SensorId.CpuPackageTempC, 10)]);
        var b = SensorProtocol.EncodeResponse([Ok(SensorId.CpuPackageTempC, 20)]);
        var ms = new MemoryStream([.. a, .. b]);
        Assert.Equal(10, (await SensorProtocol.ReadResponseAsync(ms, CancellationToken.None))[0].Value);
        Assert.Equal(20, (await SensorProtocol.ReadResponseAsync(ms, CancellationToken.None))[0].Value);
    }

    [Fact]
    public async Task Bos_veya_kimlik_listesi_gecerlidir_ama_32den_fazla_kayit_reddedilir()
    {
        Assert.Empty(await Read(Msg([1, 0])));
        var entries = Enumerable.Range(1, 33).SelectMany(i => Entry((byte)i, 1, 0)).ToArray();
        var ex = await Rejects(Msg([1, 33, .. entries]));
        Assert.Equal(SensorProtocolError.TooManyEntries, ex.Error);
    }

    [Theory]
    [InlineData(2)]   // surum
    [InlineData(0)]
    public async Task Bilinmeyen_protokol_surumu_reddedilir(byte version)
    {
        var ex = await Rejects(Msg([version, 0]));
        Assert.Equal(SensorProtocolError.BadVersion, ex.Error);
    }

    [Fact]
    public async Task Sayi_ile_uzunluk_uyusmazligi_ve_artik_bayt_reddedilir()
    {
        Assert.Equal(SensorProtocolError.BadLength, (await Rejects(Msg([1, 2, .. Entry(1, 0, 20)]))).Error);                       // 2 kayit bildirdi, 1 var
        Assert.Equal(SensorProtocolError.BadLength, (await Rejects(Msg([1, 1, .. Entry(1, 0, 20), 0xFF]))).Error);                 // artik bayt
        Assert.Equal(SensorProtocolError.BadLength, (await Rejects(Msg([1])) ).Error);                                             // baslik eksik
    }

    [Fact]
    public async Task Bilinmeyen_tekrarlanan_sensor_ve_gecersiz_durum_reddedilir()
    {
        Assert.Equal(SensorProtocolError.UnknownSensor, (await Rejects(Msg([1, 1, .. Entry(200, 0, 20)]))).Error);
        Assert.Equal(SensorProtocolError.DuplicateSensor, (await Rejects(Msg([1, 2, .. Entry(1, 0, 20), .. Entry(1, 0, 21)]))).Error);
        Assert.Equal(SensorProtocolError.BadStatus, (await Rejects(Msg([1, 1, .. Entry(1, 9, 0)]))).Error);
    }

    [Theory]
    [InlineData(double.NaN)]
    [InlineData(double.PositiveInfinity)]
    [InlineData(double.NegativeInfinity)]
    [InlineData(-51.0)]    // fiziksel aralik disi (sicaklik)
    [InlineData(201.0)]
    public async Task Ok_durumunda_NaN_Sonsuz_ve_aralik_disi_deger_reddedilir(double v)
    {
        var ex = await Rejects(Msg([1, 1, .. Entry(1, 0, v)]));
        Assert.Equal(SensorProtocolError.BadValue, ex.Error);
    }

    [Fact]
    public async Task Ok_olmayan_durumda_deger_sifirdan_farkliysa_reddedilir()
    {
        Assert.Equal(SensorProtocolError.BadValue, (await Rejects(Msg([1, 1, .. Entry(1, 1, 5.0)]))).Error);
        Assert.Equal(SensorProtocolError.BadValue, (await Rejects(Msg([1, 1, .. Entry(1, 1, double.NaN)]))).Error);
    }
}
