# Sistem İzleme Platformu Uygulama Planı

> **Ajan çalışanlar için:** GEREKLİ ALT BECERİ: Bu planı görev görev uygulamak için superpowers:subagent-driven-development (önerilir) veya superpowers:executing-plans kullanın. Adımlar takip için onay kutusu (`- [ ]`) sözdizimini kullanır.

**Hedef:** M0–M7 sırasıyla; Windows izleme agent'ı, ingest/depolama backend'i ve uyarılı web panelinden oluşan MVP'yi teslim etmek.

**Mimari:** .NET 10 düşük yetkili Windows servisi gzip JSON batch'lerini HTTPS ile tek bir Fastify sürecine gönderir (REST, ingest, SSE, zamanlanmış işler); depolama PostgreSQL+TimescaleDB; React paneli. GPU erişimi `IGpuProvider` arkasında; sıcaklık isteğe bağlı, ağsız, yükseltilmiş sensör yardımcısında ve en iyi çabadır.

**Teknoloji:** .NET 10 LTS, TypeScript, Node LTS, Fastify, zod, PostgreSQL+TimescaleDB, React, Vite, TanStack Query, Tailwind, shadcn/ui, uPlot, Vitest, xUnit, Playwright, Testcontainers, pnpm, Inno Setup.

**Şartname:** `docs/proposal.md` (Revizyon 3). Önce onu okuyun; aşağıdaki bölüm numaraları ona atıf yapar.

**Durum:** ONAYLANMADI. Kullanıcı açıkça onay verene kadar hiçbir görev başlamaz. D3 (benchmark bütçeleri) ve D9b (açık kaynak lisansı) henüz kesinleşmedi. Yalnızca M0 adım düzeyinde ayrıntılıdır; M1–M7 görev düzeyindedir (dosyalar, arayüzler, testler) ve her biri, önceki milestone'un kabul kriterleri sağlandığında kendi adım düzeyi planını alır, çünkü ayrıntılar ölçülecek sonuçlara (agent ayak izi, M2 benchmark, M4 spike) bağlıdır.

## Genel Kısıtlar

- .NET SDK, `global.json` ile en yeni .NET 10 SDK'ya sabitlenir; M0'da destek durumu Microsoft sayfasından doğrudan okunarak yeniden doğrulanır (arama özetine göre bitiş 2028-11-14).
- Agent hiçbir zaman gelen bağlantı dinleyicisi açmaz ve uzaktan komut çalıştırmaz.
- Ağa bakan agent düşük yetkilidir; yükseltilmiş donanım erişimi yalnızca isteğe bağlı, varsayılan kapalı, ağsız sensör yardımcısındadır (D4).
- Düz HTTP yalnızca sunucu loopback ise ve `--allow-insecure-loopback` verilmişse, ve yalnızca Debug derlemesinde; Release'te derleme dışı.
- `nvml.dll`, WinRing0 ve PawnIO asla paketlenmez veya yeniden dağıtılmaz; `nvml.h` metni kopyalanmaz.
- Her ilişkisel tabloda `org_id` vardır (`metric_samples` hariç; organizasyon device→org ile türetilir); `devices` üzerinde `UNIQUE(org_id,id)` ve alt tablolarda bileşik FK. `OrgContext` olmadan veri erişimi yoktur; ham bağlantı havuzu db paketinden dışa aktarılmaz. RLS ertelendi (D11).
- Cihaz kimliği istek gövdesinde veya başlıkta taşınmaz; yalnızca bearer token'dan çözümlenir. Gövdede `device_id` (eşleşse de) 400 ile reddedilir.
- Cihaz kimlik bilgileri ve enrollment token'ları sunucuda yalnızca SHA-256 hash olarak saklanır. İstisnalar yalnızca kayıp-yanıt güvenliği içindir: enroll sonrası 10 dk ve rotation üst üste binme süresince credential sunucu anahtarıyla AES-GCM şifreli tutulur, süre bitince silinir (şartname §10.2–10.3).
- GPU/sensör alanları nullable; "desteklenmiyor" sıfır olarak gösterilmez.
- Kamuya açık kapasite iddiaları yalnızca M2 benchmark'ının ölçtüğüyle sınırlıdır (D3 onayından sonra).
- Geliştirme/test kimlik bilgileri yalnızca test değerleridir ve tohum/örnek dosyalarında tutulur.
- Commit'ler küçük ve görev başınadır; mesaj biçimi `type: özet`. Belgeler Türkçe, kod/değişken/API adları İngilizce.

## İnceleme Odağı

1. NVIDIA GPU'su veya `nvml.dll` olmayan makine: agent başlar, NVIDIA GPU yok raporlar, diğer metrikler etkilenmez (G2, M4).
2. LibreHardwareMonitor yardımcısı fırlatır/takılır ya da sürücü HVCI ile engellenir: sıcaklık "kullanılamıyor" olur, agent göndermeye devam eder (M4).
3. Spool penceresinden uzun ağ kesintisi, saat atlaması, yarım yazılmış spool satırı, `spool_epoch` değişimi: en eski veri sayısı loglanarak atılır, çökme yok, sunucu zaman damgalarını doğrular (M1, M2).
4. Aynı batch iki kez teslim edilir; rotation sonrası eski token kullanılır; yeniden kullanımda iki token iptal edilir; zehirli (kalıcı 4xx) batch kuyruğu tıkamaz: yinelenen satır yok, çakışma süresi sonrası 401, spool ilerler (M2, M6).
5. A organizasyonu kullanıcısı REST, SSE veya uyarı kuralı üzerinden B cihazı ister: 404 ve hiç veri yok. A cihazının token'ı gövdede B'nin kimliğini gönderir: 400 ve B'nin verisi değişmez (M2, M3, M6).

---

## Dosya Yapısı (M0)

- `global.json`, `.editorconfig`, `.gitignore`, `README.md`, `LICENSE` (D9b sonrası)
- `pnpm-workspace.yaml`, `package.json`, `tsconfig.base.json`, `packages/config/`
- `packages/protocol/src/{ingest.ts,enroll.ts,rotate.ts,index.ts}` + `test/`: zod şemaları ve altın payload'lar
- `deploy/docker-compose.yml` (yalnızca db), `deploy/.env.example`
- `agent/windows/SysMon.Agent.sln` — `src/Agent.Service`, `tests/Agent.Tests`
- `.github/workflows/ci.yml`, `.github/workflows/license-scan.yml`
- `docs/adr/0001-record-decisions.md`, `docs/licenses.md`

## Milestone M0: Temeller

### Görev M0-1: Repo iskeleti, araç zinciri sabitleri, CI

**Dosyalar:**
- Oluştur: `global.json`, `pnpm-workspace.yaml`, `package.json`, `.gitignore`, `README.md`, `.github/workflows/ci.yml`

**Arayüzler:**
- Üretir: kök betikler `pnpm build`, `pnpm test`, `pnpm lint`; `agent/windows` içinde `dotnet test`.

- [ ] **Adım 1: .NET 10 desteğini yeniden doğrula:** Microsoft destek politikası sayfasını doğrudan oku; tarih ve bitiş tarihini `docs/adr/0001-record-decisions.md` içine kaydet.
- [ ] **Adım 2: `global.json`** oluştur: kurulu en yeni .NET 10 SDK, `rollForward: latestPatch`.
- [ ] **Adım 3: pnpm workspace** (`apps/*`, `packages/*`) ve yukarıdaki betikler; boş workspace'lerde "test yok" başarı sayılır.
- [ ] **Adım 4: CI iş akışı:** Linux işi (`pnpm install --frozen-lockfile`, lint, test) ve `windows-latest` işi (`dotnet test`). Beklenen: boş projede ikisi de yeşil.
- [ ] **Adım 5: Commit** `chore: repo skeleton and CI`.

### Görev M0-2: Protokol v1 şemaları ve altın payload'lar

**Dosyalar:**
- Oluştur: `packages/protocol/src/{ingest.ts,enroll.ts,rotate.ts,index.ts}`
- Test: `packages/protocol/test/ingest.test.ts`, `packages/protocol/test/golden/*.json`

**Arayüzler:**
- Üretir: `IngestRequestSchema` (`v: 1`, `spool_epoch: uuid`, `seq: int>=0`, `sent_at: ISO`, `samples: {ts: ISO, m: Record<metricName, number|null>}[]`, en çok 1000 örnek; **`device_id` alanı YOKTUR**; şema `strict` olduğundan gövdede `device_id` gelirse (eşleşse de) 400); `IngestResponseSchema` (`ack_seq`, `rejected: int`, `server_time`, opsiyonel `config`, opsiyonel `rotate: boolean`); hata sınıfı sözleşmesi `ErrorClass = 'transient' | 'permanent'`; `EnrollRequestSchema` (`token`, `enroll_id: uuid`, `machine_guid`, `device_info`) / `EnrollResponseSchema`; `RotateRequestSchema` (`rotation_id: uuid`); `DeviceInfoSchema` (hostname, os, agent_version, gpus[{canonical_id,name}], adapters, volumes); `CollectorStatusSchema`; `METRIC_NAME_RE = /^[a-z0-9_]+(\.[A-Za-z0-9_\-:]+){1,3}$/` ve uzunluk ≤ 64.
- Tüketen: API (M2), fake-agent (M2), agent sözleşme testleri (M1).

- [ ] **Adım 1: Başarısız testleri yaz:** `geçerli altın payload kabul edilir`, `"../etc" metrik adı reddedilir`, `65 karakterlik metrik adı reddedilir`, `1001 örnek reddedilir`, `NaN/Infinity reddedilir`, `v:2 reddedilir`, `desteklenmeyen metrik için null kabul edilir`, `gövdede device_id alanı reddedilir`.
- [ ] **Adım 2: Çalıştır** `pnpm --filter @sysmon/protocol test`; beklenen: FAIL.
- [ ] **Adım 3: Şemaları uygula**, çıkarımlı tipleri dışa aktar.
- [ ] **Adım 4: Testleri çalıştır**; beklenen: PASS.
- [ ] **Adım 5: Commit** `feat: protocol v1 schemas`.

### Görev M0-3: Yerel geliştirme veritabanı ve tohum sözleşmesi

**Dosyalar:**
- Oluştur: `deploy/docker-compose.yml` (servis `db`, TimescaleDB imajı sürümü sabit, port 5432, adlandırılmış volume), `deploy/.env.example`
- Değiştir: `README.md` ("Yerel geliştirme" bölümü, şartname §14'ü yansıtır)

**Arayüzler:**
- Üretir: `.env.example` içinde `DATABASE_URL` kuralı; belgelenmiş komut `docker compose -f deploy/docker-compose.yml up db`.

- [ ] **Adım 1: Compose dosyasını yaz** (`pg_isready` sağlık kontrolüyle).
- [ ] **Adım 2: Doğrula:** `docker compose up -d db`, ardından `docker compose ps` sağlıklı gösterir; `psql` ile `CREATE EXTENSION IF NOT EXISTS timescaledb; SHOW timescaledb.license;` çalıştır. Beklenen: uzantı oluşur; çıkan lisans değerini ADR'ye yaz (sıkıştırma ve continuous aggregate için TSL özelliklerinin açık olduğunu doğrular).
- [ ] **Adım 3: README yerel-geliştirme bölümü:** önkoşullar, portlar, loopback-HTTP kuralı.
- [ ] **Adım 4: Commit** `chore: local dev database`.

### Görev M0-4: Agent solution iskeleti (konsol + servis ana bilgisayarı)

**Dosyalar:**
- Oluştur: `agent/windows/SysMon.Agent.sln`, `src/Agent.Service/Program.cs`, `tests/Agent.Tests/SmokeTests.cs`

**Arayüzler:**
- Üretir: `Program` varsayılan olarak konsol, `--service` ile Windows Service çalışır; seçenek `--allow-insecure-loopback` (**yalnızca Debug**, Release'te `#if DEBUG` ile derleme dışı); arayüz `ICollector { string Name; TimeSpan Interval; Task<IReadOnlyDictionary<string,double?>> CollectAsync(CancellationToken ct); }` (M1'de kütüphaneye taşınır).

- [ ] **Adım 1: Başarısız test yaz:** `Host_konsol_modunda_temiz_baslar_ve_durur`, `Release_derlemesinde_insecure_loopback_bayragi_yok`.
- [ ] **Adım 2: Çalıştır** `dotnet test agent/windows`; beklenen: FAIL.
- [ ] **Adım 3: Uygula:** minimal generic host; `AddWindowsService` yalnızca `--service` ile.
- [ ] **Adım 4: Testleri çalıştır**; beklenen: PASS. Commit `feat: agent host skeleton`.

### Görev M0-5: Lisans taraması ve ADR tabanı

**Dosyalar:**
- Oluştur: `.github/workflows/license-scan.yml`, `docs/adr/0001-record-decisions.md`, `docs/licenses.md`

- [ ] **Adım 1:** CI işi: tüm npm ve NuGet lisanslarını listeler, GPL/AGPL/SSPL/bilinmeyen için başarısız olur (izin listesi `docs/licenses.md`).
- [ ] **Adım 2:** Şartname §15'in doğrulanmamış satırlarını doğrula (Node, Fastify, React, Vite, uPlot, Tailwind, shadcn/ui, Caddy, Phosphor) ve sonuçları kaydet.
- [ ] **Adım 3: Inno Setup `LICENSE.TXT` dosyasını oku**; ticari ricanın niteliğini ve projeye etkisini ADR'ye yaz.
- [ ] **Adım 4:** Projenin açık kaynak lisansı (D9b) seçimini ADR'ye yaz; `LICENSE` ekle.
- [ ] **Adım 5:** ADR 0001, kullanıcının açıkça onayladığı kararları ve onay tarihini kaydeder; D3 onaylanmadıysa "onay bekliyor" olarak işaretlenir ve M2 B6 başlamaz.
- [ ] **Adım 6:** İşi depoda çalıştır; beklenen: geçer. Commit `chore: license scan and ADR baseline`.

**M0 kabul:** İki işletim sisteminde CI yeşil; compose db sağlıklı; protokol testleri geçer; ADR onaylı kararları listeler; lisans sonuçları kaydedildi.

---

## Milestone M1: Agent çekirdeği

Görevler (M0 kabul edilince adım düzeyi plan yazılır):

- **A1 CPU/RAM/Disk/Ağ collector'ları** `agent/windows/src/Agent.Collectors/`. Arayüz: `ICollector`. Testler: sahte sayaç kaynağıyla collector'lar; metrik adları `METRIC_NAME_RE`'ye uyar; bir collector fırlatınca diğerleri durmaz; zaman aşımı `collector_status` girdisi üretir.
- **A2 Spool** `Agent.Transport/Spool.cs` (JSON-lines segmentleri + atomik durum dosyası): `Enqueue(Sample[])`, `PeekBatch(int max)`, `Ack(long seq)`; 24 saat ve 50 MB (hangisi önce), en eski atılır ve sayı loglanır. Testler: yeniden başlatmada kalıcılık, iki sınır, ack yalnızca ackli olanı siler, `spool_epoch`/`seq`/saat ofseti yeniden başlatmada korunur, **yarım yazılmış son satır atlanır**, bozuk durum dosyasında yeni epoch üretilir.
- **A3 Uploader** `Agent.Transport/Uploader.cs`: stop-and-wait, gzip POST, jitter'lı üstel backoff (tavan 5 dk). Spool yalnızca sunucu yanıtındaki `ack_seq` ilerlediğinde silinir. Hata sınıfları: *geçici* (429/5xx/saat sapması → `server_time` ile düzelt, aynı batch'i yeniden dene; ack ilerlemez) ve *kalıcı* (şema/kardinalite 4xx → sunucu 200 benzeri yanıtta `ack_seq`'i ilerletir ve `rejected` döner; agent tüm batch'in atıldığını loglar). 401/403 ise ne geçici ne kalıcıdır: agent durur ve durumu yüzeye çıkarır, spool korunur. **Sunucu SPKI parmak izi sabitleme:** enrollment paketinden gelen SPKI/özel CA dışındaki sertifika reddedilir; doğrulamayı kapatan bayrak yoktur. Testler (sahte sunucu): 10 dk kesintide sıfır kayıp; yinelenen teslim güvenli; 401'de durur; zehirli batch kuyruğu tıkamaz; loopback dışı HTTP reddedilir; yanlış SPKI'li sunucu reddedilir.
- **A4 Kimlik deposu:** token dosyası, ACL yalnızca SYSTEM/Yöneticiler/servis hesabı; rotation için atomik yazma; monotonic saat + sunucu ofseti.
- **A5 Servis kur/kaldır:** düşük yetkili servis hesabı oluşturma, "Performance Monitor Users" üyeliği, kurtarma eylemleri; Windows CI sistem testi (standart hesapla hangi PDH sayaçları okunuyor matrisi).
- **A6 Ayak izi ölçümü:** 1 saat CPU% ve çalışma kümesi kaydı; rapor docs'a eklenir. Kabul: < %1 / < 50 MB hedefiyle karşılaştırma; kaçırılırsa gerçek değer ADR'ye yazılır. Yayın modu (self-contained / framework-dependent) kararı bu ölçümle verilir.

**M1 kabul:** şartname §17.

## Milestone M2: Ingest, enrollment, depolama, benchmark

- **B0 Önce spike'lar (sıra önemli):** (1) sıkıştırılmış chunk'a idempotent insert; (2) `compress_after`/`start_offset`/`drop_after` politika kuralları (şartname §8.2); (3) B7: continuous aggregate/hypertable üzerinde RLS davranışı (RLS ertelense de gelecekteki karar için). Çıktı: ADR.
- **B1 Migration'lar** (`packages/db`): şartname §8.1 tabloları, `org_id`, `UNIQUE(org_id,id)` ve bileşik FK'lar, `device_ingest_state`; hypertable `metric_samples`; 1 dk continuous aggregate; sıkıştırma ve saklama politikaları (3 gün ham, 30 gün 1 dk). Testler (Testcontainers): kısıtlar, yinelenen insert idempotent, aggregate'in elle hesaplanan değerlerle eşleşmesi, yanlış organizasyonu bağlayan alt kayıt reddedilir.
- **B2 Enrollment** `POST /agent/v1/enroll`: token tüketimi ve cihaz oluşturma tek transaction; aynı `enroll_id`+MachineGuid ile 10 dk içinde aynı credential; hash saklama; varsayılan 1 saat geçerlilik. Credential 10 dk boyunca AES-GCM şifreli tutulur, sonra silinir; yanıt SPKI parmak izi/özel CA içeren enrollment paketini destekler. Testler: yeniden kullanım reddedilir, süresi dolan reddedilir, eşzamanlı çift kullanımda tam bir başarı, tekdüze hata yanıtları, **kayıp yanıt sonrası yeniden deneme 10 dk içinde aynı credential'ı döndürür, sonrasında reddedilir**, şifreli kopya süre sonunda silinir.
- **B3 Ingest** `POST /agent/v1/ingest`: şema doğrulama, sıkıştırılmış ≤ 1 MB ve **açılmış ≤ 10 MB** sınırı, hız sınırı, zaman damgası sınırları (±5 dk `sent_at`; 24 saatten eski/2 dk'dan ileri örnek kalıcı ret), toplu insert, `ack_seq` = o istekte commit edilen son `seq`, `rejected` sayısı, cihaz yalnızca token'dan çözümlenir. Testler: replay idempotent; kötü metrik adı kalıcı ret ve ack ilerler; iptal edilen token 401; **gövdede `device_id` (B'ninki dahil) → 400 ve B'nin verisi değişmez (negatif test, N1)**; gzip bomb reddedilir; `trustProxy` yapılandırması testi.
- **B4 Kimlik bilgisi rotation** `POST /agent/v1/rotate` `{rotation_id}` idempotent, 24 saat üst üste binme. Testler: yeni token ilk kullanılana kadar (en çok 24 saat) eski token çalışır; yeni token kullanıldıktan sonra eski token geçersizdir; 24 saat içinde yeni token hiç kullanılmazsa eski token düşer; aynı `rotation_id` aynı token'ı döndürür; bekleyen rotation varken farklı `rotation_id` reddedilir; yeni token kullanıldıktan sonra eski token sunulursa iki token da iptal edilir, cihaz işaretlenir, denetim olayı yazılır; saat sapması geçici ret + `server_time`.
- **B5 Sahte agent** `packages/fake-agent`: ayarlanabilir N cihaz, aralık, kesintiler, replay, zehirli batch, epoch sıfırlama.
- **B6 Kapasite benchmark'ı** `tests/bench/`: 10 → 50 → 100 → 250 → 500 cihaz, her basamak 30 dk, cihaz başına 30 metrik, 5 sn aralık. **Geçme ölçütleri, D3 onaylanmadan koşulamaz:** şartname §8.3 B-1…B-10 (toplu yeniden bağlanma fırtınası dahil). Sonuç, tüm belgelerdeki "500" ifadesinin yerini geçen en büyük basamakla alır.

## Milestone M3: Kimlik doğrulama ve panel v1

- **C1 Kullanıcılar/oturumlar/RBAC** (argon2id, çerez oturumları, giriş hız sınırı, Origin denetimi, ilk kurulum token'ı, owner/admin/viewer). Testler: roller, oturum sabitleme, çıkışta oturum geçersiz.
- **C2 Cihazlar ve metrik REST'i** `OrgContext` repository katmanıyla. Testler: **çapraz organizasyon IDOR paketi** (İnceleme Odağı 5), ham havuza erişim yolu yok.
- **C3 SSE akışı** `/api/v1/stream`. Testler: auth gerekli, `(org, device)` kapsamlı, yeniden bağlanmada devam, uzun bağlantıda iptal edilen oturum kesilir, kullanıcı başına bağlantı sınırı.
- **C4 Web uygulaması:** token'lar, yerleşim, filo görünümü, cihaz detay grafikleri (şartname §9). Playwright E2E: giriş, sahte cihaz enroll, canlı grafik; axe'ta kritik ihlal yok; p95 örnekten ekrana gecikme < 10 sn.
- **C5 Tasarım geçişi:** Python kurulduysa (D10 şu an hayır) UI UX Pro Max `--design-system` ve `chart` aramaları çalıştırılır, şartname §9 uzlaştırılır. Kurulmadıysa tasarım "doğrulanmamış taslak" olarak kalır ve arayüz bu notla geliştirilir.

## Milestone M4: GPU HAL ve sensörler

- **G0 Spike** (çıktı: ADR, üretim kodu yok): NVML, PDH ve LHM 3 makinede (masaüstü NVIDIA, hibrit dizüstü, GPU'suz VM); hangi alanlar doluyor, süreler, yükseltme ihtiyacı, **standart hesapla erişim matrisi**, HVCI açıkken davranış, hibrit dizüstüde güç tüketimi, SMBus/mutex çakışması, hangi LHM sürümünün hangi sürücüyü kullandığı.
- **G1 HAL tipleri** `Agent.Hardware/`: `IGpuProvider` (asenkron, `CancellationToken`), `GpuDevice` (`CanonicalId`), `GpuSample`, `GpuCapabilities` — şartname §6.2'deki gibi; sabit birimler; sağlayıcı önceliği ve tekilleştirme; uyum test tabanı `GpuProviderConformanceTests`.
- **G2 NvmlGpuProvider** (kendi P/Invoke'umuz): sahte NVML dilimiyle testler (DLL yok, init hatası, sorgu başına NOT_SUPPORTED, reset sonrası geçersiz handle, bloklanan çağrı için zaman aşımı); `nvidia-smi` ile elle karşılaştırma (±5 puan kullanım, ±50 MB VRAM, ±2 °C).
- **G3 `ISensorProvider` + `Agent.SensorHelper`:** ayrı süreç, ağ yok; named pipe (`PIPE_REJECT_REMOTE_CLIENTS`, `FILE_FLAG_FIRST_PIPE_INSTANCE`, ACL), salt okunur sabit şemalı boyut sınırlı protokol; öldür-yeniden-başlat watchdog'u. Testler: fırlatan ve takılan sahte sağlayıcı; pipe squatting girişimi; yardımcı yoksa sıcaklıklar "kullanılamıyor".
- **G4 Sunucu/UI:** GPU metrikleri `CanonicalId` ile anahtarlı; "kullanılamıyor" gösterimi; sensör kaynak etiketi.

## Milestone M5: Uyarılar

- **D1 Uyarı kuralı modeli ve değerlendirici** (durum makinesi, histerezis). OK→PENDING→FIRING→RESOLVED, flapping ve pencere kenarları için tablo güdümlü testler.
- **D2 Çevrimdışı tespiti:** sunucu alım zamanından; grace = backoff tavanı + eşik; **"ingest sağlıklı" devre kesicisi**; geç gelen spool geriye dönük alarm üretmez. Enjekte edilen saatle testler.
- **D3 Dağıtıcı** (e-posta, webhook): tekilleştirme, yeniden deneme/backoff, kanal başına hız sınırı, test gönderimi, kanal sırları bekleyen halde şifreli. Sahte SMTP ve webhook alıcılarıyla testler; SSRF: bağlanma anında çözümlenen IP kontrolü, yönlendirme kapalı, dev dışında özel/loopback engelli.
- **D4 Uyarı arayüzü** ve kural önizlemesi.

## Milestone M6: Sertleştirme ve paketleme

- **H1 CI'da güvenlik paketi:** replay, süresi dolmuş/döndürülmüş/iptal token, IDOR, ingest yazma-IDOR, zehirli batch, gzip bomb, SSRF, hız sınırları, CSP/başlık kontrolü.
- **H2 Inno Setup installer:** kurulum paketine MPL-2.0 lisans metni, `THIRD-PARTY-NOTICES` ve MPL kaynak erişim bildirimi konur; sensör yardımcısı için ağ erişimini engelleyen güvenlik duvarı kuralı kurulur; servis `sc.exe`/`--install-service` ile; düşük yetkili hesap ve "Performance Monitor Users"; sensör yardımcısı varsayılan işaretsiz bileşen; PawnIO için yönlendirme; token dosya/ortam değişkeniyle, `/LOG`'a yazılmaz; yükseltmede `CloseApplications` + servis durdur/başlat; sessiz kurulum parametreleri; kur/yükselt/kaldır. **Defender/ASR/SmartScreen test matrisi** (imzasız paket, Inno `.tmp` davranışı, servis kurulumu).
- **H3 İmzasız dağıtım azaltmaları:** SHA-256 özetleri, GitHub build provenance, Microsoft yanlış-pozitif bildirim süreci; ücretsiz açık kaynak imzalama programlarının araştırılması; D6'nın genel dağıtım öncesi yeniden değerlendirilmesi.
- **H4 Yedek/geri yükleme betiği ve tatbikatı; şartname §14 "genel hazırlık kontrol listesi" yürütülüp kaydedilir.**
- **H5 Lisans onayı:** şartname §15'e karşı, hukuki kontrol maddeleri dahil; README'de TSL bağımlılığı açıkça belirtilir.

## Milestone M7: Beta

- **R1 Dogfood:** ≥ 3 gerçek makinede iki hafta; olay günlüğü; her veri boşluğu loglanmış kesintiyle açıklanır, eksik örnek < %0,1.
- **R2 Dokümantasyon:** yardımsız izleyen biri tarafından doğrulanan sıfırdan kurulum README'si.
- **R3 Sürüm notları:** M2'den ölçülen kapasite ve bilinen donanım sınırlamaları.

---

## Öz-Değerlendirme

1. **Şartname kapsamı:** .NET 10 (M0-1), GPU HAL (M0-4 arayüz tohumu, M4 G1–G2), LHM/NVML sınırları (G0/G3), sadeleştirme (Redis/WS görevi yok), kapasite doğrulanmamış (B6), güvenlik (B2–B4, B0; C1–C3; H1), yerel geliştirme (M0-3), lisans (M0-5, H5), Inno (M0-5, H2), ikinci inceleme N1–N13 (aşağıdaki eşleme).
2. **İkinci inceleme eşlemesi:** N1→M0-2/B3; N2/N3→M0-2/A2/A3/B3; N4→B2/B4; N5→B0/B1; N6→D2; N7→B1/C2/C3; N8→şartname §10.3; uygulama M2 B2 (enrollment paketi SPKI) ve M1 A3 (sabitleme testi); N9→G3; N10→G1/G2; N11→A5/G0; N12→M0-5/H5; N13→H2/H3.
3. **Adım taraması:** M0 adımları dosyaları, imzaları, komutları ve beklenen çıktıyı adlandırır. M1–M7 kasıtlı olarak görev düzeyindedir; genişletilmeden uygulanamaz (durum bloğu bunu söyler).
4. **Tip tutarlılığı:** `ICollector` M0-4'te tanımlı, A1'de kullanılır; `IngestRequestSchema` alanları altın payload, B3 ve A3 ile eşleşir; `GpuSample`/`GpuDevice` şartname §6.2 ile eşleşir (`CanonicalId`).
5. **Oran:** M0 ayrıntılı; sonraki milestone'lar liste; yazılmamış kodun dökümü değil.
