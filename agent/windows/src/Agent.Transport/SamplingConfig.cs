using System.Text.Json;

namespace SysMon.Agent.Transport;

/// <summary>
/// Ornekleme araligi. Baslangic degeri tasarim varsayimidir (5 sn); sunucu ingest yanitindaki <c>config.interval_seconds</c>
/// ile degistirebilir (depolama butcesi: M2 olcumu, 500 cihaz x 30 metrik 1 sn'de ~240 GB/gun). Is parcacigi guvenlidir.
/// SUNUCUDAN gelen deger guvenilmez girdidir: yalnizca 1..300 arasi TAM SAYI uygulanir, digerleri yok sayilir.
/// <see cref="Interval"/> ajanin kendi (guvenilir) ic degeridir ve dogrudan atanabilir.
/// </summary>
public sealed class SamplingConfig(TimeSpan initial)
{
    public static readonly TimeSpan Min = TimeSpan.FromSeconds(1);
    public static readonly TimeSpan Max = TimeSpan.FromMinutes(5);

    private long _ticks = initial.Ticks;

    public TimeSpan Interval
    {
        get => TimeSpan.FromTicks(Interlocked.Read(ref _ticks));
        set => Interlocked.Exchange(ref _ticks, value.Ticks);
    }

    /// <summary>Sunucunun <c>interval_seconds</c> degerini uygular; gecersizse (sayi degil, tam sayi degil, aralik disi) false doner.</summary>
    public bool TryApplyServerSeconds(JsonElement value)
    {
        if (value.ValueKind != JsonValueKind.Number || !value.TryGetInt64(out var s)) return false;
        if (s < (long)Min.TotalSeconds || s > (long)Max.TotalSeconds) return false;
        Interval = TimeSpan.FromSeconds(s);
        return true;
    }
}
