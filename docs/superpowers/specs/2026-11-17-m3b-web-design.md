# M3b — Web Paneli (React): Tasarım

Tarih: 2026-11-17. Girdi: `docs/superpowers/specs/2026-11-15-m3-auth-panel-design.md` (M3 üst tasarımı), `docs/ilerleme/M3a.md`, `docs/proposal.md` §9, M3a API'si (`feat/m1-agent` @ `dd373d7`).
Karar mekanizması: kullanıcı kararları ChatGPT'ye devretti; ChatGPT 2026-11-17'de M3b'yi onayladı ve şu istekleri bildirdi: koyu tema öncelikli sade profesyonel pano; Inter veya Geist; Tailwind + shadcn/ui; TanStack Query + SSE; uPlot; **OpenAPI/sözleşme M3a ile uyumlu, backend sözleşmesi değişmeden ön yüz varsayımı yok**; ekranlar: Giriş, Genel bakış, Cihaz listesi, Cihaz detayı; güvenlik senaryoları (oturum çerezi, CSRF, 401/403/404, SSE kopması); kapanış: Playwright E2E, axe, mobil+masaüstü responsive, SSE yeniden bağlanma + önbellek güncelleme, gerçek backend ile uçtan uca, bağımsız inceleme 0 Critical / 0 Important. "Benim kararım" işaretli maddeler önerimdir.

## ChatGPT onayı (2026-11-17)
**Tasarım ONAYLANDI, plana geç.** `metric-names` ekleme ONAY; ek şartlar: yalnız son 10 dk'da veri gelen metrikler, **deterministik sıralama** (ada göre), boş liste geçerli yanıt, makul üst sınır (200), yeni metrik keşfi için SSE gerekmez (15 sn yoklama yeterli). **Setup ekranı kapsam dışı** (ilk owner güvenli CLI/betikle; setup token tek kullanımlık, varsayılan parola yok, işlem belgelenir, owner sonrası mekanizma tekrar kullanılamaz — M3a'da testli). Korunacaklar: zod şemaları tek doğruluk kaynağı ve OpenAPI güncelliği kontrolü; grafikte eksik veri = kesinti, klavye erişimi ve tablo alternatifi; **testler sahte API ile yeşil geçemez** (gerçek backend + geçici DB + Vite + mevcut Chrome). Sıra: protocol/Zod+OpenAPI → backend metric-names+sözleşme testleri → React temel+oturum → genel bakış+liste → detay+grafik+enrollment → SSE+erişilebilirlik+gerçek E2E → bağımsız inceleme. A5/B6/B-5 takip listesinde kalır, kapatılmış gösterilmez.

## Amaç ve neden
Operatör, M3a API'sinin üstünden filosunu tarayıcıda görsün: kim çevrimiçi, her makinenin CPU/bellek/disk/ağ geçmişi ve canlı değeri. M3a yalnız API verdi; arayüz yok, ilk kullanıcı bile elle oluşturuluyor.

## Hedef / hedef-dışı / anti-hedef
- **Hedef:** Giriş; Genel bakış (filo özeti); Cihaz listesi (arama, durum süzgeci, sıralama); Cihaz detayı (Genel, CPU, Bellek, Depolama, Ağ, Bilgi); "Cihaz ekle" (enrollment token üretimi, admin/owner); canlı güncelleme (SSE) ve kopma yönetimi; oturum süresi yönetimi (30 dk boşta).
- **Hedef-dışı:** GPU/Sensör/Uyarı sekmeleri ve verisi (M4/M5), kullanıcı yönetimi ve ayarlar ekranı, **ilk kurulum (setup) ekranı** (ilk owner `curl`/betik ile `POST /api/v1/setup` yapılır; belgelenir — benim kararım, kapsamı genişletmemek için), açık tema cilası (token'lar hazır, koyu öncelikli), i18n (arayüz Türkçe), PWA/çevrimdışı.
- **Anti-hedef:** JS'te saklanan token/sır; ön yüzde tahmin edilen (backend'de doğrulanmamış) sözleşme; sahte/interpolasyonlu grafik verisi; renk tek başına durum göstergesi; org dışı veri ipucu.

## Sözleşme yaklaşımı (OpenAPI)
- **Tek doğruluk kaynağı: `packages/protocol` içine panel API zod şemaları** (`api.ts`: `DeviceSummary`, `DeviceDetail`, `MetricSeries`, `Me`, `EnrollmentToken`, `LoginBody`, `SampleEvent` vb.). **Üç kullanım:** (1) ön yüz her yanıtı bu şemayla çalışma zamanında doğrular (uyumsuzluk açık hata verir, sessiz bozulma yok); (2) backend testleri gerçek yanıtları aynı şemayla doğrular (**sözleşme testi**: backend değişirse test kırılır); (3) `z.toJSONSchema` ile `docs/api/openapi.json` (OpenAPI 3.1) üretilir ve CI/yerel testte güncelliği denetlenir. Yeni bağımlılık yok (zod 4 yerleşik).
- Bu, ChatGPT şartını (backend değişmeden varsayım yok) yapısal olarak sağlar: ön yüz yalnız sözleşme testiyle kilitli şekilleri kullanır.

## Tek backend ekleme (sözleşme boşluğu, ChatGPT'ye açıkça soruldu)
Panel, bir cihazın hangi metriklere sahip olduğunu bilmeli (`disk.<harf>.used_pct`, `net.<anahtar>.rx_bps/tx_bps`; ağ anahtarı ajanın dahili `SanitizeUnique(nic.Id)` adlandırmasıdır, `device_info.adapters` ile birebir eşleşmesi garanti değildir; NIC filtresi de bazı arayüzleri izlemez). Tahmin kırılgandır. **T0:** `GET /api/v1/devices/:id/metric-names` → `{ metrics: [{ name, last_ts }] }` (son 10 dk'da örneği olan metrikler; org izole, tekdüze 404, mevcut sorgu kalıbı). M3a kapanış testleri korunur; IDOR kapsam testi bu rotayı da kapsamalı. Ağ arayüzü görünen adı: `device_info.adapters` ile en iyi çabayla eşleştirme, bulunamazsa anahtar gösterilir.

## Mimari
- `apps/web`: Vite + React 19 + TypeScript. **Geliştirmede** Vite sunucusu `/api` isteklerini API'ye proxy'ler (aynı köken: çerez ve `Origin` sorunsuz; `ALLOWED_ORIGINS=http://localhost:5173`). `__Host-sid` çerezi `Secure`; Chrome `localhost`'u güvenli bağlam sayar. **Üretimde** statik dosyalar ters proxy (M6, Caddy) ile aynı kökenden sunulur; M3b'de dağıtım kapsam dışı.
- Sunucu durumu TanStack Query'de; SSE olayları sorgu önbelleğine yazılır (`setQueryData`). Yönlendirme: React Router.
- **Oturum:** giriş sonrası çerez tarayıcıda; JS token görmez. 401 gelince giriş ekranına yönlendirir (hedef sayfa korunur); `/api/v1/me` görünür sekmede 5 dakikada bir çağrılır (30 dk boşta kuralını SSE'nin canlı tutmaması nedeniyle, M3a kararı); sekme gizliyken çağrılmaz. 403 yetersiz-rol mesajı, 404 "bulunamadı" (varlık ipucu yok), ağ hatası "bağlantı yok" durumu.
- **SSE istemcisi:** `EventSource` (aynı köken çerezle). `ready` → bağlı; kopunca üstel geri çekilmeyle (1→30 sn, jitter) yeniden bağlanma; kopukken liste/detay TanStack Query **yoklamasına** düşer (15 sn) ve arayüzde "canlı bağlantı kesildi" şeridi gösterilir; `closed` (oturum) → `/me` ile doğrula, 401 ise girişe. Kullanıcı başına 3 akış sınırı: tek sekme başına tek akış (paylaşım `BroadcastChannel` ile yapılmaz; sekme sayısı sınırı belgelenir).

## Ekranlar (metin taslağı)
```
Giriş            Genel bakış                         Cihaz listesi
┌──────────┐     Çevrimiçi 12 · Bayat 1 · Çevrimdışı 3   [Ara…] [Durum ▾] [Cihaz ekle]
│ E-posta  │     ┌ En yüksek CPU ┐┌ Bellek ┐┌ Disk ┐    ● pc-01   %12  %61  %83  5 sn önce
│ Parola   │     │ pc-07  %94   ││ pc-02..││ ...  │    ◌ pc-02   —    —    —   2 sa önce
│ [Giriş]  │     └───────────────┘└────────┘└──────┘    (sütun sıralama, klavye ile gezinme)
└──────────┘
Cihaz detayı: başlık (ad, durum rozeti = ikon+metin+renk, son görülme) · sekmeler: Genel | CPU | Bellek | Depolama | Ağ | Bilgi
             zaman aralığı: 1 sa · 6 sa · 24 sa · 7 gün · 30 gün    [uPlot grafik, eşzamanlı imleç, boşluk = kesik çizgi]
```
Mobil: liste kartlara, sekmeler yatay kaydırmaya, grafik tam genişliğe iner; dokunma hedefleri ≥ 44 px.

## Teknoloji (benim kararım, ChatGPT istekleri çerçevesinde)
React 19, Vite, TypeScript (strict), TanStack Query, React Router, Tailwind CSS v4, shadcn/ui (kopyalanan bileşenler; Radix tabanlı, erişilebilir), **Inter (değişken, kendi barındırılan `@fontsource-variable/inter`, OFL)**, Phosphor ikonları (proposal §9), uPlot. Test: Vitest + Testing Library (birim/bileşen), Playwright + `@axe-core/playwright` (E2E, erişilebilirlik). **Playwright tarayıcı indirmez:** makinedeki Chrome kanalı (`channel: "chrome"`) kullanılır (kullanıcı onayı gerektiren indirme yok); CI için sonra ele alınır. Lisans taraması her yeni bağımlılıkta geçmeli (`pnpm license-scan`).

## Tasarım dili
"Sakin operasyon konsolu" (proposal §9): koyu tema öncelikli; semantik token'lar (`surface-0/1/2`, `border`, `text-primary/secondary`, `accent`, `status-ok/warn/crit/offline/unknown`); durum = renk + ikon + metin; sayılar için tabular rakamlar; 8–32 px aralık ölçeği; süs gradyanı yok; minimal hareket, `prefers-reduced-motion`. WCAG AA kontrast (iki tema için token çiftleri; açık tema M3b'de yalnız token düzeyinde, axe koyu temada koşar).

## Grafik kuralları
uPlot; zaman aralığına göre API'den `max_points ≈ grafik piksel genişliği` ile çekilir; boş kovalarda nokta olmadığından çizgi **kesilir** (interpolasyon yok); min/max bandı + ortalama çizgi; eşzamanlı imleç (aynı sekmedeki grafikler); canlı nokta SSE'den eklenir ve animasyon karesine kısılır; klavye alternatifi: aralık düğmeleri + "yakınlaştır/uzaklaştır" düğmeleri (fırça tek yol değil); grafiğin yanında erişilebilir özet (son değer, min/ort/maks) ve veri tablosu görünümü düğmesi.

## Güvenlik (ön yüz)
Token/sır JS'te yok; yalnız `fetch(..., {credentials:"same-origin"})`; `Origin` tarayıcıdan gelir (CSRF denetimi backend'de); sıkı CSP (inline script yok; `connect-src 'self'`); XSS: tüm cihaz adı/`device_info` metin olarak basılır (`dangerouslySetInnerHTML` yok, lint kuralıyla yasak); enrollment token yalnız oluşturma yanıtında bir kez gösterilir, kopyalama düğmesi var, sayfadan ayrılınca bellekten silinir.

## Test stratejisi ve kapanış ölçütleri
- Birim/bileşen: oturum yönlendirmesi (401), durum rozeti erişilebilirliği, SSE kopma/yeniden bağlanma durum makinesi (sahte `EventSource`), önbellek güncelleme, grafik veri dönüştürme (boşluk), form doğrulama.
- **Sözleşme:** backend testleri `packages/protocol` şemalarıyla gerçek yanıtları doğrular; OpenAPI dosyası güncel mi testi.
- **E2E (Playwright, GERÇEK backend):** test altyapısı geçici DB + API süreci + Vite sunucusunu başlatır; ilk owner `setup` ile, cihazlar/veri fake-agent ile; senaryolar: giriş (yanlış/doğru), oturumsuz yönlendirme, liste→detay, canlı güncelleme (yeni örnek ekranda), SSE kesilince bant + yeniden bağlanma + veri akışı sürer, 401/403/404 ekranları, oturum iptali → girişe dönüş, enrollment token üretimi, mobil ve masaüstü görünüm.
- **axe:** her ekranda (giriş, genel bakış, liste, detay, diyaloglar) kritik/ciddi ihlal 0.
- **Örnekten ekrana gecikme (M3 kabul):** fake-agent örnek zamanı → ekranda görünme p95 ölçümü (Playwright), < 10 sn ile karşılaştırılır; rakam dürüstçe raporlanır.
- Kapanış: Playwright+axe+birim geçer; mobil/masaüstü doğrulanır; gerçek backend uçtan uca; **bağımsız inceleme Critical 0 / Important 0**; TS ve C# testleri bozulmaz; lisans taraması geçer.

## Yaklaşımlar
1. **Önce sözleşme paketi + T0, sonra arayüz (SEÇİLEN).** Ön yüz, testle kilitli şekiller üzerine yazılır; ChatGPT şartını yapısal karşılar.
2. Elle yazılmış TypeScript tipleri + OpenAPI elle: sürüklenme riski, doğrulanmamış varsayım.
3. Üçüncü taraf OpenAPI üretici/istemci kod üreticisi: yeni bağımlılık ve karmaşıklık, zod zaten tek kaynak olabilirken gereksiz.

## Builder'a bırakılanlar
Bileşen ayrıntıları, TanStack Query anahtar şeması, yoklama aralıkları, renk değerleri (kontrast ölçülerek), grafik renk/yoğunluk, boş/yükleniyor/hata durumu metinleri, Playwright altyapı betiği, `metric-names` sorgu ayrıntısı.

## Açık / sınırlar
A5 (UAC), resmi B6, B-5 kanıtı açık takip işleri (kapatılmış gibi gösterilmez). SSE tek API örneği için. Üretim dağıtımı/CSP başlıkları M6. Linux'ta argon2 ikilisi ilk CI'da doğrulanmalı.
