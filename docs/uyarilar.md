# Uyarılar ve bildirimler (M5) — kurulum ve güvenlik kılavuzu

## Ne yapar
- **Kurallar:** metrik (izin listesinden), toplama (ortalama/maksimum), pencere (15–3600 sn), operatör (`> >= < <=`), eşik, histerezis, süre (for, 0–86400 sn), önem (bilgi/uyarı/kritik), kapsam (tüm cihazlar veya cihaz listesi), kanallar.
- **Durum makinesi:** OK → PENDING → FIRING → RESOLVED. Süre dolmadan bildirim yok; FIRING iken değer eşiğin histerezis bandında kalırsa çözülmez. Veri yoksa durum değişmez. Flapping (1 saat, eşik etrafında salınım) sıfır yinelenen bildirim üretir (testli).
- **Yerleşik kurallar (her organizasyonda):** *Cihaz çevrimdışı* (60 sn eşik + 300 sn süre ≈ 6 dk grace), *Disk dolu* (herhangi bir disk > %90), *Sürekli yüksek CPU* (> %90, 5 dk), *Sürekli yüksek bellek* (> %90, 5 dk). Silinemez, devre dışı bırakılabilir/eşiği değiştirilebilir. Sıcaklık/GPU için yerleşik kural yoktur: kullanıcı tanımlı kural (`gpu.*.temp_c`, `sensor.*`).
- **Pencere sınırı:** kural penceresi en az **2 × agent örnekleme aralığı** olmalıdır (varsayılan 5 sn → en az 15 sn şema sınırı; `SAMPLE_INTERVAL_SECONDS=30` ise en az 60 sn), aksi halde `400 window_too_small` (pencere bazı turlarda boş kalır ve süreli kural tetiklenemezdi). Çevrimdışı kuralı sunucu zamanından hesaplanır, muaftır.
- **Kanallar:** webhook (POST JSON, isteğe bağlı zaman damgalı HMAC-SHA256 imzası (`X-Sysmon-Timestamp: <unix saniye>`, `X-Sysmon-Signature: sha256=<hex>`; imza `HMAC(sır, "<ts>.<gövde>")`), tekilleştirme başlığı `X-Sysmon-Dedupe`) ve e-posta (SMTP). Test bildirimi gönderilebilir.

## Çevrimdışı tespiti (N6)
Ölçüt **sunucunun alım zamanı** (`devices.last_seen_at`), örnek `ts` değil. Sunucu başladıktan sonra 6 dk, ve **ingest sağlıksızken** (ingest 5xx, veritabanı yoklaması başarısız) + sağlık geldikten sonra 6 dk çevrimdışı alarmı üretilmez; bekleyen PENDING sıfırlanır. Geç gelen spool verisi alarmı geriye dönük tetiklemez/çözmez (cihaz tekrar göründüğünde çevrimdışı olayı çözülür).

## Ortam değişkenleri (apps/api)
| Değişken | Anlam |
|---|---|
| `CHANNEL_KEY` | **Zorunlu (kanal kullanmak için)**: 32 bayt, base64 (`openssl rand -base64 32`). Yoksa/geçersizse kanal oluşturma `503 secrets_unavailable` döner ve bildirim gönderilmez. **Anahtarı kaybetmek mevcut kanalların çözülememesi demektir** (yedekleyin). Anahtar döndürme M6. |
| `ALERT_ALLOW_PRIVATE_TARGETS=1` | **YALNIZ geliştirme/test.** Özel/loopback hedeflere izin verir (SSRF koruması kapanır). `NODE_ENV=production` iken bu bayrak (ve aşağıdaki) verilirse **süreç başlamaz** (çıkış kodu 2); varsayılan her zaman kapalıdır, yalnız tam olarak `1` açar. |
| `ALERT_ALLOW_INSECURE_WEBHOOK=1` | **YALNIZ geliştirme/test.** `http://` webhook. Üretimde HTTPS zorunlu. |
| `ALERT_EVALUATE_MS`, `ALERT_NOTIFY_MS` | Değerlendirme (15000) ve bildirim kuyruğu (5000) aralıkları; en az 500. |

## Webhook imzasını doğrulama (alıcı tarafı)
Alıcı, `X-Sysmon-Timestamp` ve `X-Sysmon-Signature` başlıklarını **ham gövde** ile doğrulamalıdır:
1. `ts` sayısal olmalı ve şimdiki zamandan ±300 sn içinde olmalı (eski/gelecekteki istek = replay şüphesi → reddet).
2. `beklenen = "sha256=" + hex(HMAC_SHA256(sır, ts + "." + ham_gövde))`.
3. `beklenen` ile `X-Sysmon-Signature` değerini **sabit süreli** karşılaştır (Node: `crypto.timingSafeEqual`).
4. Tekrar gönderimlere karşı `X-Sysmon-Dedupe` değerini tekilleştirme anahtarı olarak sakla. Referans uygulama: `verifyWebhookSignature` (apps/api/src/alerts/webhook.ts).

## Veri kesintisinde davranış
Pencerede veri yoksa (cihaz sustu, ingest kesildi): **açık (FIRING) olay otomatik çözülmez** ve çözüldü bildirimi gönderilmez (cihaz ölü olabilir; "Cihaz çevrimdışı" kuralı ayrıca yakalar). **PENDING** durumu sıfırlanır: "süre" kesintisiz ihlal ister, veri boşluğuyla dolmuş sayılmaz; veri dönünce süre baştan sayılır.

## Güvenlik modeli
- **Sırlar:** webhook URL'si (içinde token olabilir), imza sırrı, SMTP sunucusu/parolası/alıcılar **AES-256-GCM** ile şifreli saklanır (nonce(12)‖etiket(16)‖şifreli metin; her şifrelemede yeni CSPRNG nonce; **AAD = organizasyon + kanal kimliği**: sır başka satıra/organizasyona kopyalanırsa çözülmez). API'ye yalnız sır içermeyen **özet** döner (webhook: ana makine; e-posta: sunucu, port, alıcı sayısı). Denetim kayıtları sır içermez. Hata metinleri URL yolu/sorgusu/parola/sunucu yanıtı içermez.
- **SSRF (webhook ve SMTP):** hedef adres çözümlenir ve engelli aralıklara karşı doğrulanır (loopback, özel RFC1918, link-local — bulut meta veri `169.254.169.254` dahil —, CGNAT, belgelendirme/test, çoklu yayın, rezerve; IPv6 karşılıkları, IPv4-mapped/NAT64/6to4 dahil); bir ad birden çok adrese çözülürse **biri** engelliyse **tümü** reddedilir (DNS rebinding); bağlantı **aynı doğrulanmış adrese** yapılır (ikinci çözümleme yok), SNI/sertifika/Host asıl ad üzerinden. Kontrol hem kanal **oluşturmada** hem **her gönderimde** yapılır. Yönlendirme takip edilmez (3xx hata). Üretimde HTTPS zorunlu, URL'de kimlik bilgisi yok, TLS sertifika + ana makine adı doğrulaması her zaman açık. SMTP'de TLS zorunlu (örtük TLS veya STARTTLS).
- **Tenant izolasyonu:** kural, olay, kanal, bildirim `org_id` ile bileşik FK'lıdır; her sorgu org ile sınırlıdır; başka organizasyonun kaynağı olmayanla **aynı 404**; kuralda başka org'un cihaz/kanalı `400 invalid_reference`; başka org kanalına bildirim yapısal olarak oluşamaz. Yazma: yalnız `owner|admin`; viewer okur.
- **Metrik güvenliği:** metrik adı/operatör/toplama sabit izin listesindedir (`packages/protocol/src/alerts.ts`); SQL'e hiç eklenmez, yalnız parametre. DB'ye doğrudan yazılmış izin dışı metrikli kural değerlendirilmez.
- **Dayanıklılık:** olay ve bildirim kuyruğu **PostgreSQL'de kalıcı**. API yeniden başlarsa `pending` ve kirası dolmuş `sending` satırları yeniden alınır. `(olay, tür, kanal)` TEKİL: aynı olay için ikinci bildirim satırı oluşamaz; `sent` bir daha gönderilmez. Üstel geri çekilme 30 sn → 15 dk, en çok 8 deneme; kalıcı hata (4xx/SSRF/anahtar yok) hemen `failed`; kanal başına dakikada 20 gönderim sınırı (fazlası deneme hakkı harcanmadan ertelenir). **At-least-once:** işçi, HTTP isteğinden sonra ama `sent` işaretlemeden önce çökerse tek bir bildirim tekrar gidebilir; alıcılar `X-Sysmon-Dedupe` ile tekilleştirmelidir.
- **Tekillik:** aynı anda **tek değerlendirici** (PostgreSQL advisory kilidi). Çok örnekli API **desteklenmiyor** (M6): zamanlanmış işler süreç içidir.

## Bilinen sınırlar (kapatılmış değil)
- *Çözüldü* bildirimi, olay açıldığındaki değil kuralın **o anki** kanal listesine gider (kural arada düzenlenirse farklı kanallara düşebilir). **Saklama (M6):** her saat temizlik — `sent`/`failed` bildirimler 30 günden, çözülmüş olaylar 180 günden eskiyse silinir; açık olaylar ve bekleyen/gönderilen bildirimi olan olaylar asla silinmez (`apps/api/src/alerts/retention.ts`). Kanal silme tek transaction'dır. Anahtar (`CHANNEL_KEY`) yedekleme ve kayıp uyarıları: [yedekleme.md](yedekleme.md). Bunlar M6.
- Kural önizlemesi yok (M6). Kural düzenleme arayüzünde etkin/devre dışı, silme ve **kanal bağlama** (yerleşik kurallar dahil) var; eşik değişikliği API ile `PATCH`. Yerleşik kurallar varsayılan olarak hiçbir kanala bağlı değildir: bildirim için her kurala "Kanalları düzenle" ile kanal bağlayın.
- Panel kuralda yalnız "tüm cihazlar" kapsamı sunar (API cihaz listesi kabul eder).
- Çözüldü bildirimi, kural devre dışı/silinirken **gönderilmez** (olay sessizce kapanır).
- Webhook alıcıları kendi tarafında imza doğrulamalı; sır dönmez, kaybolursa kanal yeniden oluşturulmalı.
- E-posta için gerçek bir SMTP sunucusuyla uçtan uca doğrulama yapılmadı (sahte SMTP ile test edildi).
