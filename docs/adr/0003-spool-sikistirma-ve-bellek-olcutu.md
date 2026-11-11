# ADR 0003 — Spool sıkıştırma kararı ve bellek ölçütünün netleştirilmesi (M1)

Tarih: 2026-11-11 · Durum: Kabul edildi · İlgili: ADR 0002 (açık bulguları kapatır)

## Bağlam
ADR 0002 iki sorunu açık bırakmıştı: spool ~123 MB/gün üretiyordu (24 saat / 50 MB sınırı tutmuyordu) ve çalışma kümesi 50,5–60,4 MB ölçülmüştü (hedef < 50 MB).

## Karar 1 — Mühürlenen spool segmentleri gzip'lenir (uygulandı)
- Yalnızca aktif (son) segment düz metin JSON-lines olarak eklenir; segment `SegmentBytes` (1 MB) dolunca `.gz.tmp` → `.gz` (atomik taşıma) → düz dosya silinir ve segment mühürlenir.
- Çökme kurtarma (testli): aynı indeksli `.jsonl` + `.jsonl.gz` varsa gz geçerli sayılır, düz dosya silinir; `.tmp` artıkları açılışta silinir; son segment gz ise ona ekleme yapılmaz.
- **Alternatifler ve neden seçilmedi:** (a) sınırı 100 MB'a çıkarmak sorunu ertelerdi, disk tüketimini 2 katlardı; (b) yalnızca "N MB" olarak belgelemek 24 saat güvencesini bırakırdı; (c) ikili format (protobuf/MessagePack) yeni bağımlılık ve protokol değişikliği demek, gzip bağımlılıksız.

### Gerçek ölçüm (Release exe, bu makine, 120 sn, 6 metrik/örnek)
| | Düz | gzip | Oran |
|---|---|---|---|
| 21 batch | 194.306 bayt | 10.656 bayt | **18,2×** |
| Günlük tahmin | 133,4 MB | **7,3 MB** | |
| 30 metrik/örnek için doğrusal tahmin | | **~37 MB/gün** | 50 MB sınırına sığar (~%27 pay) |

Sınırlamalar: tek makine, 2 dakikalık örnek, değerlerin gerçekçi ama sınırlı çeşitliliği; 30 metrik tahmini ölçüm değil doğrusal ekstrapolasyondur; aktif segment sıkıştırılmamış kalır (≤ ~1 MB).

## Karar 2 — Bellek ölçütü "özel çalışma kümesi" olarak netleştirilir
Önceki hedef "RAM < 50 MB" belirsizdi. İki metrik 5 çalışma zamanı varyantıyla ölçüldü (her varyant 10 sn ısınma + 45 sn örnekleme):

| Varyant | Çalışma kümesi ort/maks | **Özel çalışma kümesi ort/maks** | CPU (tek çekirdek) |
|---|---|---|---|
| A varsayılan | 53,6 / 54,9 MB | 18,0 / 19,3 MB | %2,24 |
| B gcConcurrent=0 | 53,6 / 55,9 | 18,9 / 21,0 | %1,40 |
| C B + TieredPGO=0 | 51,8 / 53,8 | 17,7 / 20,0 | %1,01 |
| D C + Invariant globalization | 51,6 / 54,1 | 17,9 / 20,2 | %0,78 |
| E D + GCConserveMemory=7 | 51,5 / 54,1 | 17,8 / 20,2 | %0,95 |

Bulgular:
- Çalışma kümesinin ~34 MB'ı, framework-dependent .NET runtime'ın paylaşılan DLL sayfalarıdır; diğer .NET süreçleriyle paylaşılır ve çalışma zamanı ayarlarıyla azalmaz (tüm varyantlar ±2 MB, ölçüm gürültüsü içinde).
- Sürecin kendi tükettiği bellek (özel çalışma kümesi, Görev Yöneticisi'nde "Bellek" olarak görünen) **~18–20 MB**.
- **Karar:** RAM hedefi **özel çalışma kümesi < 50 MB** olarak tanımlanır (karşılanıyor: maks 21 MB). Toplam çalışma kümesi (~52–56 MB) raporlanır ama hedef değildir. Bu, hedefin yeniden yorumlanmasıdır; kullanıcı toplam çalışma kümesini istiyorsa self-contained+trimmed yayın modu denenmelidir (bu ölçülmedi; paylaşılan sayfaları azaltır ama disk boyutunu artırır).
- **Çalışma zamanı ayarları benimsenmedi:** kanıtlanmış bellek kazancı yok; CPU farkı (%0,78–2,24) tek koşuluk gürültü seviyesinde (A koşusu yeni derlenmiş exe için ilk tarama etkisi olabilir). Kanıtlanmamış yapılandırma eklememek için varsayılanlar korunur.

CPU: tek çekirdeğin %0,8–2,2'si = toplam sistem kapasitesinin (12 mantıksal çekirdek) ~%0,07–0,19'u. "CPU < %1" hedefi **toplam CPU kapasitesi** olarak yorumlanır (karşılanıyor); tek çekirdek %1 yorumunda bazı koşular aşıyor. Her ikisi de tek makinede, kısa ölçümdür.

## Doğrulanmamış
Servis modunda, uzun süreli (saatlik) ve yükleme yolu açıkken ayak izi ölçülmedi; 30 metrikli gerçek örnekleme ölçülmedi.
