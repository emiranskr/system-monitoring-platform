# M2 Devir Notu — 2026-11-12 akşam (yarın buradan devam)

## Durum özeti
- **Dal:** `feat/m2-backend` (taban `feat/m1-agent` @ `515f5fc`). **Birleştirilmedi, M3'e geçilmedi, push yok.**
- **M1:** `feat/m1-agent`'ta tamamlandı (kapanış onayı kullanıcının devrettiği ChatGPT'den alındı).
- **Karar mekanizması:** Kullanıcı, kararları ChatGPT'ye (Chrome'da açık "Teknik Plan Elestirisi" sohbeti) sormamı ve onun dediğini yapmamı istedi; kendisinden onay beklenmeyecek. ChatGPT'nin M2 için sırası: **filtre → agrega ölçeği → B-5 → M2 bağımsız inceleme (Critical 0 / Important 0) → birleştirme → M3.** A5 UAC'si iptal edildi; ChatGPT: M3'ü engellemez ama M2 "tamamen doğrulandı" denemez.
- **Testler (son koşu):** TS: protocol 14 + db 15 + api 111 geçti (lint 0 hata, çıkış 0, yakalanmamış hata yok). C# (son tam koşu, NicFilter sonrası): Debug 212, Release 197 geçti.

## Bağımsız inceleme (HEAD `61b619d` üzerinde): Critical 0, Important 5, Minor 11, Informational 12
| ID | Konu | Durum |
|---|---|---|
| I-1 | `TRUST_PROXY=true` sahte X-Forwarded-For'a açık | **Düzeldi** (`690c2fa`): yalnızca IP/CIDR listesi; `true` ve sayısal biçim reddedilir (sayısal biçimin Fastify'da istemciyi çözmediği ölçüldü) |
| I-2 | Başarısız-auth kilidi DoS aracı | **Düzeldi**: geçerli token'lar etkilenmez; yalnızca sınırı aşan IP'nin GEÇERSİZ istekleri 429 |
| I-3 | Havuz `error` dinleyicisi/zaman aşımı yok | **Düzeldi**: `createPool` + ödünç alınan istemci için `connectGuarded` (4 işlem noktası) |
| I-4 | B-5 iddiası kanıttan güçlü | **Belge düzeltildi** (M2.md §2e "DÜZELTME": iyimser–kötümser duyarlılık, B-5 kanıtlanmadı) |
| I-5 | Test boşlukları | **Kısmen**: rotasyon yarışları (3), sıkıştırılmış chunk'a gerçek HTTP ingest, 0003 yükseltme testleri yazıldı ve geçti. **Kalan:** e2e testlerinin atlanınca sessizce yeşil kalması (aşağıda) |

### Bu oturumda bulunan EK gerçek hata (inceleme dışı, düzeltildi)
**Sıkıştırılmış chunk'ta, bir gerçek yinelenen içeren tek `INSERT … ON CONFLICT DO NOTHING`, aynı ifadedeki YENİ satırları sessizce yazmıyordu** (0 satır, hata yok, istek 200+ack). SQL düzeyinde yeniden üretildi (TimescaleDB 2.17.2). `apps/api/src/ingest.ts`'e `WHERE NOT EXISTS` ön elemesi eklendi (SQL sondasında 2/2 yeni satır yazıldı, yinelenen ezilmedi); regresyon testi `hardening.test.ts` (düzeltmeden önce kırmızı, sonra yeşil). **Bu düzeltme henüz commit'lenmedi ise ilk iş commit'lemek** (aşağıya bakın). Etki alanı: yalnız 12 saatten eski (sıkıştırılmış) verinin geç gelen, yinelenen anahtar içeren batch'leri; ama sessiz veri kaybıydı. Not: önce yanlış bir sonda "hedefsiz ON CONFLICT yinelenen ekler" sonucunu verdi; JS `Date` mikrosaniyeyi kestiği için sondanın hatasıydı ve geri alındı.

## YARIN yapılacaklar (öncelik sırasıyla)
1. `git status` kontrolü; bekleyen değişiklikleri commit'le (ingest `NOT EXISTS` düzeltmesi, `hardening.test.ts`, `upgrade.test.ts`, `createTestDb({migrate:false})`, belgeler).
2. **I-5 kalanı:** `agent-e2e.test.ts` ve `tls-e2e.test.ts` `describe.skipIf(!enabled)` ile exe/openssl yoksa SESSİZCE yeşil kalıyor. Öneri: `SYSMON_REQUIRE_E2E=1` ise önkoşul yoksa testi başarısız say; exe'nin kaynaktan eski olup olmadığını da denetle.
> **2026-11-15 güncelleme:** I-5 kalanı (SYSMON_REQUIRE_E2E + exe tazelik) `5c528e9`. **M-1 ÖLÇÜLDÜ: iddia yanlıştı** — Zod takvim-geçersiz tarihi zaten reddediyor (400, 500 YOK); davranış testle kilitlendi. **M-3 (a,b,c) ve M-6 düzeltildi** (kırmızı→yeşil testlerle). M-2, M-7, M-10, M-11 de yapıldı (`ipKey` IPv6 /64 + bellek üst sınırı, sunucu zaman aşımları, NIC istisna/belirtilmemiş adres, M2.md düzeltmesi). Kalan: dar yeniden inceleme → ChatGPT özeti → birleştirme.

3. **Düşük maliyetli Minor'lar (TDD):**
   - **M-1** takvim-geçersiz zaman damgası (`2026-02-31T…Z`) Zod'dan geçip PG 22008 ile **kalıcı 500** oluyor (agent 5xx'i geçici sayar: batch hiç atılmaz, hat tıkanır). Örnek düzeyinde reddet (`rejected++`), `sent_at` için 400; `NaN` tarih penceresini de aşıyor.
   - **M-3** aynı `enroll_id`, farklı token yarışında `enrollments` PK ihlali 500 olur (uniform 401 olmalı); `CREDENTIAL_KEY` değişince yeniden deneme `decrypt` 500'ü; retry dalı token'ın özgün enrollment'a ait olduğunu denetlemiyor.
   - **M-6** `0003`: `remove_compression_policy(..., if_exists => true)` (henüz dağıtılmadığı için dosya düzenlenebilir).
   - **M-2** sınırlayıcı: 100k anahtar üstünde O(n) tarama ve sınırsız büyüme; üst sınır/eviction ve IPv6 /64 anahtarı.
   - **M-7** Fastify `requestTimeout`/`connectionTimeout`/`maxConnections` ayarı (doğrudan TLS dağıtımında yavaş-yükleme riski).
   - **M-11** M2.md içindeki bayat bölümler: §1 test sayıları (83/83, "2 gün sonra sıkıştırma"), §3 "B5/hız sınırı/TLS yok" artık yanlış.
   - **M-10** NIC: `GetIPProperties()` her NIC için filtre öncesi çağrılıyor (fırlatan sanal adaptör tüm ağ kolektörünü düşürür) → NIC başına try/catch; `0.0.0.0`/`::` "adres" sayılıyor.
4. **Ertelenenler / açık (Minor/Info):** M-4 (reuse/rotate yarış penceresi, zincir O→N→M), M-5 (composite FK boşlukları: `superseded_by`, `enrollment_tokens.device_id`), M-8 (1 sn örneklemede saat ofseti titreşimi aynı saniyeye düşüp örnek düşürebilir; 5 sn varsayılanda ihmal edilebilir), M-9 (2 dk gelecek sınırı < 5 dk `sent_at` sınırı), batch içeriği 5 sn/5 sn'de 1–2 örnek.
5. **Dar kapsamlı yeniden inceleme** (yalnız düzeltme diff'i) → Critical 0 / Important 0 → ChatGPT'ye özet → birleştirme (`feat/m2-backend` → `feat/m1-agent`, yalnızca fast-forward/yerel, push yok) → M3.

## Hâlâ açık (M2'yi "tamamen doğrulandı" demeyi engelleyen)
- **A5 servis doğrulaması** (UAC penceresi iptal edildi; yeniden denenmedi). Komut: `Verify-ServiceInstall.ps1` yönetici olarak, yayın dizini `dotnet publish … -c Release`. ChatGPT: ilk fırsatta tamamlanmalı.
- **Resmi B6** (30 dk/basamak, B-1…B-10 ölçütleri tek tek).
- **B-5 kanıtlanmadı** (M2.md §2e düzeltmesi). B-3a proposal'daki tanımı "raporlanan kapasite göstergesi" olarak güncellenmedi.
- Gerçek ajan agrega sıkıştırması ölçekte; GPU/sıcaklık kolektörleri sonrası seri sayısı.

## Çalıştırma notları
- Veritabanı: `docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d --wait` (konteyner `deploy-db-1`, TimescaleDB 2.17.2; **şu an çalışır durumda bırakıldı**). Testler her koşuda geçici veritabanı açıp siler.
- TS: `pnpm -r --if-present test`, `pnpm -r --if-present lint`; yük aracı `node tools/bench/bench.mjs …`, depolama `tools/bench/storage.mjs`, gerçek veri `tools/bench/real-compress.mjs` (ön koşul: `pnpm -r build`).
- C#: `dotnet test agent/windows/SysMon.Agent.sln -c Debug|Release`. Betik dosyası çalıştırma politikası kapalı: PowerShell'de dosya yerine satır içi komut kullan (politika DEĞİŞTİRİLMEDİ).
- Kanıtlar: `docs/ilerleme/kanit/` (A5/soak logları, ölçüm JSON'ları).
