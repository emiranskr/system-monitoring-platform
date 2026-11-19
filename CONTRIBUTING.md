# Katkı rehberi

Katkılarınız için teşekkürler. Küçük düzeltmeler doğrudan PR olabilir; büyük değişiklikler için önce bir issue açın.

## Geliştirme ortamı
Node ≥ 22, pnpm, Docker Desktop (TimescaleDB), .NET 10 SDK (agent için). Kurulum: [README → Hızlı başlangıç](README.md#hızlı-başlangıç-yerel-demo).

```bash
pnpm install
docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d --wait
pnpm build && pnpm lint
pnpm test                 # tüm paketler + betik testleri (Docker DB gerekir)
pnpm test:security        # güvenlik kapısı
dotnet test agent/windows/SysMon.Agent.sln
pnpm --filter @sysmon/web e2e   # gerçek tarayıcıyla uçtan uca (Chrome gerekir)
```

## Kurallar
- **Test önce:** davranış değişikliği/hata düzeltmesi için önce başarısız olan bir test yazın, sonra düzeltin.
- **Güvenlik:** her sorgu `org_id` ile sınırlı olmalı; yeni rota IDOR kapsamına (`apps/api/test/idor.test.ts`) eklenmeli; sır içeren değer log/yanıta girmemeli.
- **Sözleşme:** API değişikliği `packages/protocol` şemalarından geçer; `pnpm --filter @sysmon/protocol gen:openapi` ile `docs/api/openapi.json` güncellenir.
- **Bağımlılık:** yeni bağımlılık eklerseniz `pnpm license-scan` temiz olmalı (izinli lisanslar: `scripts/license-policy.mjs`).
- **Dürüstlük:** doğrulanmamış bir şeyi belgelerde "tamamlandı" diye yazmayın.
- Commit mesajları kısa ve açıklayıcı olsun; Türkçe veya İngilizce kabul edilir.

## Pull request
Açıklamada ne değiştiğini, nasıl doğruladığınızı (çalıştırdığınız komutlar) ve bilinen sınırları yazın. CI (build, lint, test, güvenlik kapısı, .NET, E2E) yeşil olmalıdır.
