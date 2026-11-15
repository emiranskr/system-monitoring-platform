# M3 — Auth + Panel v1: Tasarım

Tarih: 2026-11-15. Girdi: `docs/proposal.md` (§7, §9, §10.5, §10.6, §17 M3, B-6), M2 kodu (`feat/m1-agent` @ `caea950`).
Karar mekanizması: kullanıcı kararları ChatGPT'ye devretti ([[chatgpt-karar-yetkisi]]); bu belgenin onayı ChatGPT'dendir. Aşağıda "Benim kararım" işaretli maddeler benim önerimdir.

## Amaç ve neden
Operatör kendi Windows filosunu tarayıcıdan görebilsin: kim çevrimiçi, her makinenin CPU/bellek/disk/ağ geçmişi ve canlı değeri. M2 yalnızca yazma tarafını (ingest) yapıyor; okuma, kullanıcı girişi ve arayüz yok.

## Kabul ölçütleri (proposal M3)
Giriş çalışır; filo ve cihaz görünümleri; örnekten ekrana p95 < 10 sn (LAN); B-6: grafik sorgusu 24 sa p95 < 500 ms, 30 gün p95 < 1 sn (ingest sürerken); axe'ta kritik ihlal yok; IDOR paketi (A org kullanıcısı B'nin hiçbir verisine erişemez).

## Hedef / hedef-dışı / anti-hedef
- **Hedef:** salt-okunur panel v1: Giriş, Filo görünümü, Cihaz detayı (Genel, CPU, Bellek, Depolama, Ağ, Bilgi). Enrollment token üretimi (yönetici, tek ekran). Canlı güncelleme (SSE).
- **Hedef-dışı (M3'te yok):** GPU/Sensör sekmeleri verisi (M4: "bu donanımda yok" yer tutucusu), uyarılar ve bildirimler (M5), kullanıcı yönetimi ekranı ve çoklu kullanıcı davetleri (yalnız ilk `owner`; diğer roller şema olarak hazır), açık tema cilası, i18n (arayüz Türkçe).
- **Anti-hedef:** varsayılan parola; JS'te saklanan token; org dışı veri sızıntısı; M2 ingest yolunun yavaşlaması; grafiklerde sahte (interpolasyonlu) veri.

## Parçalara bölme (sıra)
M3 iki bağımsız alt proje; her biri kendi planı ve incelemesiyle gider.
1. **M3a — Backend: kullanıcılar, oturumlar, okuma API'si, SSE.** Tarayıcı olmadan tam test edilebilir (inject + gerçek TimescaleDB).
2. **M3b — Web paneli (React).** M3a API sözleşmesi üzerine; Playwright + axe.

## M3a tasarımı

### Kimlik ve oturum (proposal §10.6)
- Yeni migration `0004_users_sessions.sql`: `users (id, org_id, email citext unique, password_hash, role owner|admin|viewer, disabled_at, created_at)`, `sessions (id_hash bytea pk, org_id, user_id, created_at, last_seen_at, expires_at, ip, ua)`, `setup_tokens (token_hash, created_at, used_at)`. Bileşik FK `(org_id, …)` disiplini korunur.
- **argon2id** (Node'da `argon2` yerel eklentisi veya salt-JS `@node-rs/argon2`; lisans taramasından geçmeli — **Benim kararım:** `@node-rs/argon2`, ön derlenmiş ikili, MIT).
- Oturum: 256 bit rastgele kimlik; DB'de yalnızca SHA-256 özeti; çerez `__Host-sid` (httpOnly, Secure, SameSite=Lax, Path=/); girişte yeni kimlik (yenileme); **boşta 30 dk, mutlak 12 sa** (ChatGPT kararı 2026-11-15; ilk öneri 12 sa/7 gün idi, owner/admin için fazla uzun bulundu); çıkışta ve parola/rol/devre-dışı değişiminde o kullanıcının TÜM oturumları iptal.
- Parametreler yapılandırılabilir (`SESSION_IDLE_MINUTES`, `SESSION_ABSOLUTE_HOURS`) ama varsayılanlar yukarıdaki değerlerdir.
- CSRF: durum değiştiren isteklerde `Origin` denetimi (izinli kökenler yapılandırma) + SameSite. Çerezsiz istek 401.
- Giriş hız sınırı: IP+e-posta başına (mevcut `RateLimiter`, `ipKey`); hatalı e-posta/parola aynı yanıt ve benzer süre (kullanıcı sızdırma yok, sabit sahte hash doğrulaması).
- **İlk kurulum:** sunucu ilk açılışta `users` boşsa yüksek entropili (256 bit) tek kullanımlık kurulum token'ı üretir ve **yalnızca bir kez süreç stderr'ine** yazar (yapılandırılmış günlük/dosya günlüğüne YAZILMAZ; ChatGPT kararı, proposal §10.6'daki "günlüğe yazılır"ın yerine geçer); DB'de yalnızca SHA-256 özeti. Yeniden başlatmada `users` hâlâ boşsa eski token geçersiz kılınır ve yenisi üretilir. `POST /api/v1/setup` token + e-posta + parola ile `owner` oluşturur; token **atomik tüketilir** (tek `UPDATE … WHERE used_at IS NULL RETURNING`, eşzamanlı iki istekten yalnızca biri başarılı); sonra uç nokta kalıcı kapanır. Varsayılan parola yok.
- Roller: M3'te `owner/admin` yönetim (enrollment token), `viewer` salt-okunur; denetim günlüğü (`audit_events`) giriş/çıkış/enrollment token olaylarını yazar.

### Okuma API'si (`/api/v1/*`, oturum şart, her sorgu `OrgContext`'ten)
- `GET /api/v1/devices` — filo listesi: ad, durum (çevrimiçi/bayat/çevrimdışı: `last_seen_at`'ten, eşik 3×ingest aralığı ve 2 dk), son CPU/bellek/disk özeti.
- `GET /api/v1/devices/:id` — cihaz bilgisi (`device_info`) + durum.
- `GET /api/v1/devices/:id/metrics?metric=…&from=…&to=…&max_points=…` — **cihaz kimliği önce çağıranın org'una göre çözülür** (§10.5); kaynak aralığa göre seçilir: ≤ 3 sa ham (`metric_samples`), üstü `metric_1m`; `time_bucket` ile en çok ~1000 noktaya indirgenir; boş aralıklar için nokta üretilmez (grafikte boşluk).
- `POST /api/v1/enrollment-tokens` (admin+) — mevcut `createEnrollmentToken`; yanıt token'ı yalnızca bir kez gösterir.
- Hepsi zod şemalı; OpenAPI zod'dan üretilir (proposal §7.1) — **Benim kararım:** `zod-to-openapi` benzeri yerine önce şemalar paylaşılan pakette (`packages/protocol`) tutulur, OpenAPI üretimi M3b'de kullanıcıya fayda sağlarsa eklenir.

### Canlı akış (SSE)
- `GET /api/v1/stream?devices=…` — in-process olay: ingest `commit` sonrası `(org_id, device_id)` için hafif "yeni örnek" olayı yayar (tek API süreci, harici kuyruk yok). Fan-out anahtarı `(org_id, device_id)`; kullanıcı başına bağlantı sınırı; her 60 sn oturum/rol/iptal yeniden doğrulanır; kalp atışı 25 sn. Olay yükü son değerler (grafik noktası), tam geçmiş değil.
- Ingest'e eklenen maliyet ihmal edilebilir olmalı: olay yayını `COMMIT` SONRASI, hata yutan; abone yoksa sıfır iş. Test: yayın hatası ingest'i bozmaz.

### Test stratejisi
Gerçek TimescaleDB + `inject`. IDOR paketi (iki org, fake-agent ile veri): A kullanıcısı B'nin cihaz/metrik/SSE/enrollment-token'ına erişemez. Oturum: iptal, süre aşımı, çerez bayrakları, CSRF, kaba kuvvet, sabit zamanlı sahte hash. B-6: `tools/bench` genişletilir (ingest sürerken sorgu p95, 24 sa ve 30 gün). Örnekten-ekrana gecikme: fake-agent → SSE olayı ölçümü.

## M3b tasarımı (özet; ayrıntılı tasarım M3a bitince)
`apps/web`: React + Vite + TypeScript + TanStack Query + Tailwind + shadcn/ui + uPlot (proposal §3.2). Sunucu durumu TanStack Query'de; SSE olayları sorgu önbelleğine yazılır. Koyu tema öncelikli, semantik token'lar (proposal §9), durum = renk + ikon + metin, Phosphor ikonları. Grafik: eşzamanlı imleç, boşluk (interpolasyon yok), "bayat" görünümü, klavye ile yakınlaştırma alternatifi, `prefers-reduced-motion`. Playwright e2e + axe (iki tema). Yazı tipi seçimi ve görsel yön M3b tasarımında; Python kurulu olmadığından UI-UX Pro Max veri arama betikleri çalıştırılmaz (D10), bu bir sınırdır.

## Yaklaşımlar
1. **Önce backend (M3a), sonra arayüz (M3b) — SEÇİLEN.** API sözleşmesi test edilmiş olur; arayüz sabit bir zemine yazılır; IDOR/oturum riski (en yüksek güvenlik değeri) önce kapanır.
2. Dikey dilimler (önce giriş+filo uçtan uca, sonra cihaz detayı…): erken görsel geri bildirim, ancak kimlik/org izolasyonu hem API hem arayüzde birlikte değişir; hataları ayırt etmek zorlaşır.
3. Önce arayüz (sahte API ile): hızlı görünür ilerleme, ama sözleşme değişince yeniden yazım riski yüksek.
Neden 1: güvenlik ve kapasite (B-6) riskleri backend'dedir; arayüzün sahte veriyle doğrulanamayacak tek kabulü p95 gecikmedir ve o da M3a'da ölçülür.

## ChatGPT onayı ve ek şartları (2026-11-15)
Bölme (M3a→inceleme→M3b) ve başlama ONAYLI. Ek şartlar: argon2 yerel ikilisi Windows+Linux CI'da doğrulanır ve parametreler OWASP asgarisi üstünde, giriş gecikmesi ölçülerek seçilir; **SSE in-process olayları yalnız tek API örneğinde yeterlidir — çoklu örnek için yetersiz olduğu belgelenir**; IDOR testleri başka org'un cihaz kimlikleriyle 404/403 ve sızıntı yok doğrular; güvenlik testleri mutasyonla doğrulanır; her mantıksal görev ayrı commit. **M3a kapanış ölçütü:** Debug/Release testleri, IDOR/org izolasyonu, oturum+CSRF+enrollment güvenliği, SSE bağlantı ve yeniden doğrulama, gerçek PostgreSQL entegrasyonu geçer; bağımsız inceleme Critical 0 / Important 0. Kapsam genişletilmez (M4/M5/kullanıcı yönetimi ekranı dışarıda).

## Kısıtlar
Tek API süreci; harici kuyruk/Redis yok; ham bağlantı havuzu depolama paketinden dışa verilmez (§10.5; mevcut `@sysmon/db` ihracı bu kurala göre gözden geçirilecek — **builder'a bırakılan**); lisans taraması geçmeli (`pnpm license-scan`); M2 testleri yeşil kalmalı; push yok.

## Builder'a bırakılanlar
Tablo/indeks ayrıntıları, hata kodu adları, sayfalama ayrıntısı, SSE olay şeması alan adları, `max_points` varsayılanı, argon2 parametreleri (OWASP asgarisi üstü, makinede ~100 ms ölçülerek).

## Açık / sınırlar
A5, B6 resmi, B-5 hâlâ açık (M2 takip işleri). B-6 ölçümü yalnızca tek makine, kısa süre olacak; resmi sayılmaz.
