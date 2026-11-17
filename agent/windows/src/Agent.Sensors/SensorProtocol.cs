using System.Buffers.Binary;

namespace SysMon.Agent.Sensors;

public enum SensorProtocolError
{
    Truncated,
    TooLarge,
    BadVersion,
    BadOpcode,
    BadLength,
    TooManyEntries,
    UnknownSensor,
    DuplicateSensor,
    BadStatus,
    BadValue,
}

public sealed class SensorProtocolException(SensorProtocolError error) : Exception($"sensor protokol hatasi: {error}")
{
    public SensorProtocolError Error { get; } = error;
}

/// <summary>
/// Yardimci sureç ile agent arasindaki ikili, salt okunur, sabit semali protokol. Tum sayilar LITTLE-ENDIAN.
/// Istek (2 bayt): [surum=1][opcode=1 ReadAll].
/// Yanit: [u32 yuk uzunlugu][yuk]; yuk = [surum=1][sayi u8][sayi x (id u8, durum u8, deger f64)]; yuk = 2 + 10 x sayi, en cok 4 KiB, en cok 32 kayit.
/// Uzunluk alani okunur okunmaz sinir kontrol edilir; sinirin ustunde HICBIR govde okunmaz/bellek ayrilmaz. Okuyucular tam
/// uzunlukta okur (parcali okuma guvenli), fazla bayt sonraki mesaja kalir. Gecersiz her sey SensorProtocolException ile reddedilir.
/// </summary>
public static class SensorProtocol
{
    public const byte Version = 1;
    public const byte OpReadAll = 1;
    public const int MaxPayloadBytes = 4096;
    public const int MaxEntries = 32;
    private const int EntryBytes = 10;

    public static byte[] EncodeRequest() => [Version, OpReadAll];

    public static byte[] EncodeResponse(IReadOnlyList<SensorReading> readings)
    {
        if (readings.Count > MaxEntries) throw new ArgumentException("cok fazla kayit", nameof(readings));
        var seen = new HashSet<SensorId>();
        foreach (var r in readings)
        {
            if (SensorSpec.Validate(r) is { } err) throw new ArgumentException($"gecersiz okuma {r.Id}: {err}", nameof(readings));
            if (!seen.Add(r.Id)) throw new ArgumentException($"tekrarlanan sensor {r.Id}", nameof(readings));
        }
        var payloadLen = 2 + EntryBytes * readings.Count;
        var buf = new byte[4 + payloadLen];
        BinaryPrimitives.WriteUInt32LittleEndian(buf, (uint)payloadLen);
        buf[4] = Version;
        buf[5] = (byte)readings.Count;
        var o = 6;
        foreach (var r in readings)
        {
            buf[o] = (byte)r.Id;
            buf[o + 1] = (byte)r.Status;
            BinaryPrimitives.WriteDoubleLittleEndian(buf.AsSpan(o + 2), r.Value);
            o += EntryBytes;
        }
        return buf;
    }

    public static async Task ReadRequestAsync(Stream s, CancellationToken ct)
    {
        var b = new byte[2];
        await ReadExactAsync(s, b, ct).ConfigureAwait(false);
        if (b[0] != Version) throw new SensorProtocolException(SensorProtocolError.BadVersion);
        if (b[1] != OpReadAll) throw new SensorProtocolException(SensorProtocolError.BadOpcode);
    }

    public static async Task<IReadOnlyList<SensorReading>> ReadResponseAsync(Stream s, CancellationToken ct)
    {
        var lenBuf = new byte[4];
        await ReadExactAsync(s, lenBuf, ct).ConfigureAwait(false);
        var len = BinaryPrimitives.ReadUInt32LittleEndian(lenBuf);
        if (len > MaxPayloadBytes) throw new SensorProtocolException(SensorProtocolError.TooLarge); // govde okunmaz, bellek ayrilmaz
        if (len < 2) throw new SensorProtocolException(SensorProtocolError.BadLength);

        var payload = new byte[len];
        await ReadExactAsync(s, payload, ct).ConfigureAwait(false);
        return DecodePayload(payload);
    }

    private static IReadOnlyList<SensorReading> DecodePayload(byte[] p)
    {
        if (p[0] != Version) throw new SensorProtocolException(SensorProtocolError.BadVersion);
        int count = p[1];
        if (count > MaxEntries) throw new SensorProtocolException(SensorProtocolError.TooManyEntries);
        if (p.Length != 2 + EntryBytes * count) throw new SensorProtocolException(SensorProtocolError.BadLength);

        var list = new List<SensorReading>(count);
        var seen = new HashSet<SensorId>();
        for (var i = 0; i < count; i++)
        {
            var o = 2 + EntryBytes * i;
            var r = new SensorReading((SensorId)p[o], (SensorStatus)p[o + 1], BinaryPrimitives.ReadDoubleLittleEndian(p.AsSpan(o + 2)));
            if (SensorSpec.Validate(r) is { } err) throw new SensorProtocolException(err);
            if (!seen.Add(r.Id)) throw new SensorProtocolException(SensorProtocolError.DuplicateSensor);
            list.Add(r);
        }
        return list;
    }

    private static async Task ReadExactAsync(Stream s, byte[] buf, CancellationToken ct)
    {
        var read = 0;
        while (read < buf.Length)
        {
            var n = await s.ReadAsync(buf.AsMemory(read), ct).ConfigureAwait(false);
            if (n == 0) throw new SensorProtocolException(SensorProtocolError.Truncated);
            read += n;
        }
    }
}
