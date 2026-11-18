# Üretim dağıtımı (M6 iskeleti)

> Bu belge ve `deploy/` örnekleri **iskelettir**: internete açık gerçek dağıtım bu depoda yapılmadı ve test edilmedi. Alan adı, sertifika ve ağ ayarlarını kendi ortamınıza göre uyarlayın.

## Mimari
`İstemci (tarayıcı/agent)` → **TLS sonlandıran ters proxy (nginx örneği)** → `API (127.0.0.1:8443, düz HTTP)` → `PostgreSQL + TimescaleDB`. Panel (`apps/web/dist`) proxy tarafından **statik** sunulur; `/api/` ve `/agent/` API'ye gider. API yalnız loopback'te dinler.

## Adımlar
1. **Derleme:** `pnpm install && pnpm build` → `apps/web/dist` (statik panel) ve `apps/api/dist` (API).
2. **Veritabanı:** Üretim parolasıyla TimescaleDB 2.17.x / PG16. (`deploy/docker-compose.yml` yalnız yerel geliştirme içindir.) İlk açılışta `MIGRATE=1`.
3. **Ortam:** `deploy/api.env.example` dosyasını kopyalayıp değerleri doldurun. Anahtarlar (`CREDENTIAL_KEY`, `CHANNEL_KEY`) `openssl rand -base64 32` ile üretilir ve **veritabanı yedeğinden ayrı** saklanır ([yedekleme.md](yedekleme.md)).
4. **Proxy:** `deploy/nginx.example.conf` → alan adı, sertifika yolları, `root` dizini. Statik dosyaları `root` altına kopyalayın.
5. **İlk kurulum:** API ilk açılışta tek kullanımlık kurulum belirtecini **yalnız stderr'e** yazar; `POST /api/v1/setup` ile ilk owner oluşturulur.
6. **Agent:** Release derlemesi yalnız **HTTPS** kabul eder; sertifika zincirine güvenilmelidir (isteğe bağlı SPKI sabitleme: `SPKI_PINS`).

## Güvenlik başlıkları ve CSP
Tek kaynak: `deploy/security-headers.mjs`. CSP: `default-src 'none'`; betik yalnız `'self'` (**`unsafe-eval` ve satır içi betik yok**); stil dosyaları `'self'`, satır içi yalnız `style-src-attr` (React/uPlot stil öznitelikleri); `connect-src 'self'` (API ve SSE aynı kökenden); `frame-ancestors 'none'`; `object-src 'none'`. Ayrıca HSTS, `nosniff`, `Referrer-Policy: no-referrer`, COOP/CORP, `X-Frame-Options: DENY`, `Permissions-Policy`.

Doğrulama (otomatik):
- `apps/web/e2e/csp.spec.ts`: **derlenmiş** paneli bu başlıklarla gerçek Chrome'da açar (filo, uyarılar, cihaz grafiği); CSP ihlali olmamalıdır. Bu test bir gerçek ihlali yakaladı: zod'un JIT derleyicisi `Function("")` yoklaması yapıyordu → `apps/web/src/zod-config.ts` ile JIT kapatıldı (işlevsel fark yok).
- `scripts/deploy-config.test.mjs`: nginx örneğinin başlıkları kaynakla **aynı**; `unsafe-eval` yok; SSE tamponlaması kapalı; TLS ≥ 1.2; `X-Forwarded-For` istemciden alınmaz; env örneğinde geliştirme bayrağı etkin değil.

## Geliştirme bayrakları üretimde reddedilir
`ALERT_ALLOW_PRIVATE_TARGETS=1` / `ALERT_ALLOW_INSECURE_WEBHOOK=1` (SSRF korumasını ve HTTPS zorunluluğunu kapatır) yalnız geliştirme/test içindir. `NODE_ENV=production` iken bunlardan biri tanımlıysa **API başlamaz** (çıkış kodu 2; `apps/api/test/alert-devflags.test.ts` derlenmiş süreci çalıştırarak sınar). Bayraklar varsayılan **kapalıdır**: `NODE_ENV` tanımsız/yanlış olsa bile hiçbir şey kendiliğinden açılmaz. Bunun ötesinde `NODE_ENV`'in üretimde **gerçekten** ayarlandığını operatör sağlar (örnek env dosyası `NODE_ENV=production` içerir).

## Bilinen sınırlar (kapatılmamış)
- Gerçek internete açık dağıtım, gerçek sertifika/alan adı, yük testi ve proxy'nin gerçek davranışı **test edilmedi** (örnek yapılandırma `nginx -t` ile de sınanmadı).
- Çok örnekli API desteklenmez (zamanlanmış işler süreç içi; tek değerlendirici advisory kilidiyle korunur).
- `CHANNEL_KEY`/`CREDENTIAL_KEY` döndürme/yeniden şifreleme yok.
- Hız sınırı (rate limit) API'dedir; proxy düzeyinde ek sınır önerilir.
