# Web paneli: geliştirme ve ilk kurulum

Panel (`apps/web`) yalnızca **aynı kökenden** API'ye konuşur (oturum çerezi `__Host-sid`, CSRF `Origin` denetimi). Geliştirmede Vite sunucusu `/api` isteklerini API'ye proxy'ler.

## 1. Çalıştırma (geliştirme)
Gereksinimler: Node ≥ 22, pnpm, Docker Desktop (TimescaleDB), `pnpm install`.

```bash
docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d --wait
pnpm -r build
```

API'yi başlatın (ortam değişkenleri):
- `DATABASE_URL` (deploy/.env içindeki), `CREDENTIAL_KEY` (32 bayt base64), `MIGRATE=1` (ilk açılışta şema),
- `ALLOWED_ORIGINS=http://localhost:5173` (**zorunlu**: boşsa giriş dahil durum değiştiren istekler 403 olur),
- isteğe bağlı: `PORT` (8443), `HOST` (127.0.0.1), `SESSION_IDLE_MINUTES` (30), `SESSION_ABSOLUTE_HOURS` (12).

```bash
node apps/api/dist/server.js
pnpm --filter @sysmon/web dev      # http://localhost:5173 (API_PORT ile proxy hedefi: varsayılan 8443)
```

## 2. İlk kullanıcı (owner) — setup ekranı yoktur
Kullanıcı yokken API ilk açılışta **tek kullanımlık kurulum token'ını süreç stderr'ine BİR KEZ** yazar (günlük dosyasına yazılmaz; saklanmaz, yalnızca özeti veritabanındadır). Token'ı kopyalayıp owner oluşturun (varsayılan parola yoktur, parola ≥ 12 karakter):

```bash
curl -X POST http://localhost:5173/api/v1/setup -H "Origin: http://localhost:5173" -H "content-type: application/json" -d '{"token":"<STDERR_TOKEN>","email":"owner@sirket.com","password":"<EN_AZ_12_KARAKTER>"}'
```
- Token atomik tüketilir; ikinci kullanımda ve owner oluştuktan sonra uç nokta kalıcı olarak kapanır (404).
- Token kaybolursa: API'yi (kullanıcı yokken) yeniden başlatın; eski token geçersiz olur ve yenisi yazılır.

Giriş: `http://localhost:5173/giris`. Cihaz eklemek için Cihazlar sayfasındaki **Cihaz ekle** (owner/admin) ile tek kullanımlık enrollment token üretin.

## 3. Testler
```bash
pnpm --filter @sysmon/web test      # birim/bileşen (Vitest, ağ sahte)
pnpm --filter @sysmon/web e2e       # GERÇEK uçtan uca: geçici DB + derlenmiş API + Vite + Chrome (Docker DB çalışıyor olmalı)
```
E2E tarayıcı **indirmez**: makinedeki Google Chrome (`channel: "chrome"`) kullanılır. Portlar `E2E_WEB_PORT` (5199) / `E2E_API_PORT` (18599) ile değiştirilebilir. Sonuçlar `apps/web/playwright-report/`; gecikme ölçümü `docs/ilerleme/kanit/m3b-latency-*.json`.

## 4. Bilinen sınırlar
- Canlı akış (SSE) **tek API örneği** içindir (süreç-içi olay yolu).
- Üretim dağıtımı (statik sunum, CSP başlıkları, TLS) M6 kapsamındadır.
- Ağ grafikleri `net.*.rx_bps/tx_bps` metriklerini BAYT/sn gösterir (metrik adı "bps" olsa da ajan bayt/sn gönderir).
