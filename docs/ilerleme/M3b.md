# M3b — Web Paneli (durum)

Tarih: 2026-11-17 (devam ediyor). Dal: `feat/m3b-web` (taban `feat/m1-agent` @ `dd373d7`, M3a birleştirilmiş). Tasarım: `docs/superpowers/specs/2026-11-17-m3b-web-design.md` (ChatGPT onaylı); plan: `docs/superpowers/plans/2026-11-17-m3b-web.md`. **Birleştirilmedi, push yok.**

## İlerleme
| Görev | Durum | Kanıt |
|---|---|---|
| G1 Protocol sözleşmesi (zod) + OpenAPI 3.1 + güncellik testi | **Tamam** `30afa50` | `packages/protocol` 24 test; `docs/api/openapi.json`; mutasyon yakalandı |
| G2 Backend `metric-names` + sözleşme testleri (tüm yanıtlar şemayla, SSE gövdesi dahil) | **Tamam** `5c522da` | api 273 test; 3 mutasyon yakalandı, `ORDER BY` mutasyonu bu ortamda EŞDEĞER (kolasyon C + planlayıcı sıralı gruplama) — sıralama garantisi sorguda duruyor |
| G3 `apps/web` iskeleti (Vite 8, React 19, Tailwind v4, Inter, tokenlar, kontrast + ham-HTML-yasağı testleri) | **Tamam** `2454e5c` | web 12 test; lisans 218 paket 0 izinsiz |
| G4 API istemcisi + oturum + Giriş | **Tamam** `8eebf1f` | web 48 test; mutasyonlar: sözleşme doğrulaması, keep-alive görünürlük, login-401 ayrımı yakalandı; safeNext `//` kontrolü EŞDEĞER (URL kökeni kontrolü aynı girdiyi reddediyor, bilinçli savunma derinliği) |
| G5 Genel bakış + Cihaz listesi + kabuk | **Tamam** `e532f66` | web 89 test; Türkçe i/I/ı/İ arama katlaması testle bulundu; NULL-sona mutasyonu yakalandı; **karar:** mobilde kart yerine sütun azaltma (Bellek/Disk gizlenir) |
| G6 Cihaz detayı + grafikler | **Tamam** `21eb42c` | web 140 test; boşluk=kesinti eşik mutasyonu, özet/yakınlaştırma/“yok” durumu mutasyonları yakalandı. uPlot jsdom’da sahte (gerçek çizim G9 E2E’de doğrulanacak). **Bulgu:** ağ metrikleri `net.*.rx_bps/tx_bps` BAYT/sn (adı yanıltıcı); arayüz B/s-KB/s-MB/s gösterir, adlandırma düzeltmesi ajan/protokol değişikliği → takip |
| G7 "Cihaz ekle" | **Tamam** `73b2f0f` | web 154 test; 4 mutasyon yakalandı (token silme, rol, TTL, mutasyon 401) |
| G8 SSE istemcisi | **Tamam** `a5b48c9` | web 178 test; 6 mutasyon yakalandı (geri çekilme sınırı/sıfırlama, closed yeniden bağlanma, revoked canlanma, olay doğrulama, closed+401). **Karar/sapma:** grafik serisine canlı nokta ekleme YOK (SSE liste/özet/detay durumunu günceller; seriler 15 sn yoklama); yoklama SSE varken de açık (cihazın sessizce çevrimdışı olması SSE olayı üretmez) |
| G9 Playwright E2E (gerçek backend) + axe + responsive + gecikme | **Devam ediyor** | Altyapı (): geçici TimescaleDB + derlenmiş API + Vite + Chrome kanalı çalışıyor; `auth.spec` 6/6 gerçek tarayıcıda. **E2E’nin yakaladığı GERÇEK HATA:** SSE olayları önbelleği 4–5 sn’de bir güncellediği için TanStack Query per-sorgu `refetchInterval` zamanlayıcısı sürekli sıfırlanıyor, 15 sn yoklama HİÇ ateşlenmiyordu (cihaz durum geçişleri ve oturum kaybı fark edilmezdi; 182 birim testi bunu göstermemişti). Çözüm: sabit zamanlayıcılı `usePolling` (regresyon testli, mutasyon yakalandı). Kalan senaryolar: fleet, device, live, enroll, a11y, responsive, latency |
| G10 Belgeler + bağımsız inceleme | Bekliyor | |

## Notlar / kararlar
- TypeScript 7'de `baseUrl` kaldırılmış: `tsconfig` yalnız `paths` kullanır.
- shadcn bileşenleri (button, input, dialog, tabs, badge…) ihtiyaç duyuldukça ilgili görevde eklenir (YAGNI); G3'te yalnız altyapı (`cn`, tokenlar) var.
- Toplam doğrulama (G3 sonu): protocol 24, web 12, db 21, api 273 test geçti; lint temiz; C# bu işte değişmedi.

## Açık takip işleri (kapatılmış DEĞİL)
A5 servis doğrulaması (UAC), resmi 30 dk B6, B-5 (150 GB) kanıtı, olçekte B-6, Linux'ta argon2 ikilisi (ilk CI), M3a M-3 (audit saklama/oturum temizleme → M6).
