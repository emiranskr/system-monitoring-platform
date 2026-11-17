# M3b — Web Paneli (durum)

Tarih: 2026-11-17 (devam ediyor). Dal: `feat/m3b-web` (taban `feat/m1-agent` @ `dd373d7`, M3a birleştirilmiş). Tasarım: `docs/superpowers/specs/2026-11-17-m3b-web-design.md` (ChatGPT onaylı); plan: `docs/superpowers/plans/2026-11-17-m3b-web.md`. **Birleştirilmedi, push yok.**

## İlerleme
| Görev | Durum | Kanıt |
|---|---|---|
| G1 Protocol sözleşmesi (zod) + OpenAPI 3.1 + güncellik testi | **Tamam** `30afa50` | `packages/protocol` 24 test; `docs/api/openapi.json`; mutasyon yakalandı |
| G2 Backend `metric-names` + sözleşme testleri (tüm yanıtlar şemayla, SSE gövdesi dahil) | **Tamam** `5c522da` | api 273 test; 3 mutasyon yakalandı, `ORDER BY` mutasyonu bu ortamda EŞDEĞER (kolasyon C + planlayıcı sıralı gruplama) — sıralama garantisi sorguda duruyor |
| G3 `apps/web` iskeleti (Vite 8, React 19, Tailwind v4, Inter, tokenlar, kontrast + ham-HTML-yasağı testleri) | **Tamam** `2454e5c` | web 12 test; lisans 218 paket 0 izinsiz |
| G4 API istemcisi + oturum + Giriş | **Tamam** `8eebf1f` | web 48 test; mutasyonlar: sözleşme doğrulaması, keep-alive görünürlük, login-401 ayrımı yakalandı; safeNext `//` kontrolü EŞDEĞER (URL kökeni kontrolü aynı girdiyi reddediyor, bilinçli savunma derinliği) |
| G5 Genel bakış + Cihaz listesi | Bekliyor | |
| G6 Cihaz detayı + grafikler | Bekliyor | |
| G7 "Cihaz ekle" | Bekliyor | |
| G8 SSE istemcisi | Bekliyor | |
| G9 Playwright E2E (gerçek backend) + axe + responsive + gecikme | Bekliyor | Chrome kurulu (`C:\Program Files\Google\Chrome\Application\chrome.exe`), `channel:"chrome"`; tarayıcı indirme yok |
| G10 Belgeler + bağımsız inceleme | Bekliyor | |

## Notlar / kararlar
- TypeScript 7'de `baseUrl` kaldırılmış: `tsconfig` yalnız `paths` kullanır.
- shadcn bileşenleri (button, input, dialog, tabs, badge…) ihtiyaç duyuldukça ilgili görevde eklenir (YAGNI); G3'te yalnız altyapı (`cn`, tokenlar) var.
- Toplam doğrulama (G3 sonu): protocol 24, web 12, db 21, api 273 test geçti; lint temiz; C# bu işte değişmedi.

## Açık takip işleri (kapatılmış DEĞİL)
A5 servis doğrulaması (UAC), resmi 30 dk B6, B-5 (150 GB) kanıtı, olçekte B-6, Linux'ta argon2 ikilisi (ilk CI), M3a M-3 (audit saklama/oturum temizleme → M6).
