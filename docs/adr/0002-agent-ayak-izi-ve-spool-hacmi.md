# ADR 0002 — Agent ayak izi ölçümü ve spool hacmi (M1 A6)

Tarih: 2026-11-11 · Durum: Açık (karar bekleyen bulgular)

## Ölçüm yöntemi
Release derlemesi (`Agent.Service.exe`, framework-dependent, .NET 10), gerçek Windows 11 makinesinde (12 mantıksal çekirdek, Türkçe yerel ayar), `--data-dir` ile geçici dizin, **sunucu yok** (yalnızca toplama + spool; Release'te düz HTTP yasak olduğundan yükleme yolu ölçülemedi). 10 sn ısınma, ardından 80 sn boyunca her 5 sn'de çalışma kümesi örneği, CPU süresi farkı.

## Sonuçlar (gerçek, tek koşu)
| Ölçüt | Hedef | Ölçülen | Durum |
|---|---|---|---|
| CPU | < %1 | tek çekirdeğin %0,70'i (sistemin %0,058'i) | Hedef karşılandı (bu koşuda) |
| RAM (çalışma kümesi) | < 50 MB | min 50,5 / maks 60,4 MB | **Hedef KAÇIRILDI** |
| Spool büyümesi | 24 sa ≤ 50 MB | 80 sn'de ~125 KB ≈ **~123 MB/gün** (yalnızca ~10 metrik) | **24 saat sınırı tutmaz**; 50 MB ≈ ~10 saat |

## Yorum ve olası çözümler (karar bekliyor)
- RAM: framework-dependent çalışma kümesi; trimmed/ReadyToRun/`DOTNET_gcServer=0`, `GCHeapHardLimit`, `TieredPGO` kapatma gibi seçenekler denenmedi. Hedef 50 MB'a gerçekçi mi, 80–100 MB mı, M1 sonrası belirlenmeli. Tek koşu; değişkenlik ölçülmedi.
- Spool: örnek başına JSON ve gzip'siz disk. Seçenekler: segmentleri gzip'lemek, sınırı 100 MB'a çıkarmak veya sınırı "24 saat" yerine "N MB" olarak belgelemek. Şu an davranış: 50 MB dolunca en eski segment atılır ve `DroppedBatches` sayılır (testli).
- Ölçüm sınırlamaları: yükleme (HTTP/gzip) CPU maliyeti, servis modu, uzun süreli (saatlik) koşu ve 30 metrikli senaryo ölçülmedi.
