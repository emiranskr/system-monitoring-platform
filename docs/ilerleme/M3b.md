# M3b — Web Paneli (durum)

Tarih: 2026-11-17. Dal: `feat/m3b-web` (taban `feat/m1-agent` @ `dd373d7`, M3a birleştirilmiş). Tasarım: `docs/superpowers/specs/2026-11-17-m3b-web-design.md` (ChatGPT onaylı); plan: `docs/superpowers/plans/2026-11-17-m3b-web.md`; kurulum: `docs/web-kurulum.md`. **Birleştirilmedi, push yok. Bağımsız inceleme henüz yapılmadı** (kapanış ölçütü: Critical 0 / Important 0).

> **DEVİR (2026-11-17 sonu):** Tüm görevler commit'li. Bağımsız inceleme (ayrı ajan) başlatıldı ama sonucu bu oturumda ALINMADI; yarın ilk iş: sonuç yoksa incelemeyi yeniden başlat (`git diff dd373d7..HEAD`, kapsam: güvenlik, doğruluk, sözleşme, E2E geçerliliği/mutasyon, a11y, belge-kod). Sonra bulguları TDD ile düzelt → dar yeniden inceleme → ChatGPT özeti (sapmalar: shadcn CLI yok, mobil sütun azaltma, canlı nokta ekleme yok, net bayt/sn) → fast-forward birleştirme (push yok).

## 1. Yapılanlar ve kanıtlar
| Görev | Çıktı | Kanıt |
|---|---|---|
| G1 | Panel API sözleşmesi (zod, `packages/protocol/src/api.ts`) + OpenAPI 3.1 üretimi + güncellik testi | protocol 24 test; `docs/api/openapi.json`; mutasyon yakalandı |
| G2 | Backend `GET /api/v1/devices/:id/metric-names` (son 10 dk, bayt düzeninde sıralı, ≤ 200, org izole) + sözleşme testleri (tüm yanıtlar + SSE gövdesi şemayla) | api 273 test; 3 mutasyon yakalandı; `ORDER BY` mutasyonu bu ortamda EŞDEĞER (kolasyon C + planlayıcı sıralı gruplama, sıralama garantisi sorguda duruyor) |
| G3 | `apps/web` iskeleti: Vite 8, React 19, Tailwind v4, Inter (değişken), semantik token'lar (koyu+açık), WCAG AA kontrast testi, ham-HTML yasağı testi | web testleri; lisans 218 paket 0 izinsiz |
| G4 | API istemcisi (zod ile çalışma zamanı doğrulama; `ContractError`/`SessionExpiredError`/`NetworkError`), oturum, `RequireAuth`, güvenli `next`, keep-alive, Giriş | mutasyonlar: sözleşme doğrulaması, görünürlük, login-401 ayrımı yakalandı |
| G5 | Genel bakış + Cihaz listesi (rozet ikon+metin, arama, sıralama/aria-sort, NULL sona, XSS metin) + kabuk | Türkçe i/I/ı/İ katlaması testle bulundu; NULL-sona mutasyonu yakalandı |
| G6 | Cihaz detayı (sekmeler, `metric-names` ile keşif, uPlot: boşluk=kesinti, min/maks bandı, özet, erişilebilir veri tablosu, aralık + klavye yakınlaştır/uzaklaştır) | 3 mutasyon yakalandı |
| G7 | "Cihaz ekle" (owner/admin, TTL 5..1440, token tek gösterim + kopyala + pano yedeği, kapanınca silinir, mutasyon 401 → giriş) | 4 mutasyon yakalandı |
| G8 | SSE istemcisi (üstel geri çekilme + jitter, `closed` → yeniden bağlanma yok + `/me` doğrulama, zod olay doğrulama), `applyEvent`, `LiveProvider`/`LiveBanner` | 6 mutasyon yakalandı |
| G9 | **Gerçek backend** Playwright E2E (geçici TimescaleDB + derlenmiş API + Vite + Chrome): auth, fleet, device, live, enroll, a11y (axe), responsive (3 görünüm), latency | tam paket **91/91**; 4 E2E mutasyonu yakalandı (API org süzgeci, boşluk eşiği, SSE yeniden bağlanma, düşük kontrast) |

**Test toplamı:** protocol 24 + db 21 + api 273 + web birim 182 = 500; Playwright E2E 91 (desktop/tablet/mobile); C# Debug 214 / Release 199 (bu işte değişmedi). Lint temiz; lisans 218 paket 0 izinsiz.

## 2. Gerçek tarayıcıda/E2E'de bulunan ve düzeltilen HATALAR (birim testleri görmemişti)
1. **15 sn yoklama HİÇ çalışmıyordu:** SSE olayları önbelleği 4–5 sn'de bir güncellediğinden TanStack Query per-sorgu `refetchInterval` zamanlayıcısı sürekli sıfırlanıyordu → cihaz durum geçişleri (çevrimiçi→bayat→çevrimdışı) ve oturum kaybı fark edilmiyordu. Çözüm: sabit zamanlayıcılı `usePolling` (regresyon testli, mutasyon yakalandı; commit `d2ebcd3`).
2. **axe — `dt`/`dd` `dl` dışında** (Genel bakış) ve **kaydırılabilir veri tablosu klavyeyle erişilemiyor** (`scrollable-region-focusable`): düzeltildi.
3. **Dokunma hedefi:** sıralama düğmesi 18 px genişlikteydi (WCAG 2.2 AA asgari 24 px): `min-w-11`.
4. Giriş hız sınırı, her E2E testinin UI'dan giriş yapmasıyla tetiklendi (test düzeni): `storageState` ile rol başına tek giriş.

## 3. Ölçüm (ÖN ÖLÇÜM, tek makine)
Örnekten ekrana (ingest gönderimi → ekranda CPU değeri, SSE, 30 örnek): **p50 19 ms · p95 25 ms · p99 40 ms · maks 40 ms** (bütçe < 10 sn). **Sınırlar:** API, DB, Vite ve tarayıcı aynı makinede; ajanın örnek toplama/batch yaşı (gerçek ajan örneği batch aralığı kadar bekletir) ve gerçek ağ gecikmesi DAHİL DEĞİL; yoklama değil SSE yolu ölçüldü. Resmi ölçüm değildir. Ham sonuç: `docs/ilerleme/kanit/m3b-latency-30ornek.json`.

## 4. Benim kararlarım / sapmalar (kontrol edilsin)
- **shadcn/ui CLI kullanılmadı:** shadcn deseninde sade bileşenler (`Button`/`Input`/`Label`) elle yazıldı; `Dialog` ve `Tabs` Radix tabanlı (`@radix-ui/react-*`). Tasarımın "shadcn/ui" ifadesinden sapma.
- Mobil liste: kart görünümü yerine **sütun azaltma** (Bellek/Disk küçük ekranda gizli).
- Grafik serisine **canlı nokta ekleme yok:** SSE liste/özet/detay durumunu günceller; seriler 15 sn yoklamayla yenilenir. Yoklama SSE varken de açık (cihazın sessizce çevrimdışı olması SSE olayı üretmez).
- Arama katlaması: `I/ı/İ/i` eşdeğer (cihaz adları çoğunlukla ASCII).
- Ağ metrikleri **bayt/sn** gösterilir (ajan `net.*.rx_bps/tx_bps` adıyla bayt/sn gönderir; adlandırma düzeltmesi ajan/protokol değişikliği → takip).
- Ağ arayüzü görünen adı `device_info.adapters` ile en iyi çabayla eşleşir; eşleşmezse anahtar gösterilir (ad uydurulmaz).
- Grafik kapsayıcısında `data-gaps` özniteliği (kesinti sayısı) yalnız test/hata ayıklama içindir.
- Dokunma hedefi: yükseklik ≥ 44 px, genişlik ≥ 24 px (WCAG 2.2 AA asgarisi).
- Erişilebilirlik taraması **yalnız koyu tema**da (varsayılan); açık tema yalnız token düzeyinde (kontrast testli, axe koşulmadı).

## 5. Açık takip işleri (kapatılmış DEĞİL)
- **A5** Windows servis doğrulaması (UAC, kullanıcı onaylamalı), **resmi 30 dk B6**, **B-5** (150 GB) kanıtı, ölçekte B-6 (648 M satır), Linux'ta argon2 ikilisi (ilk CI), M3a M-3 (audit saklama/oturum temizleme → M6).
- Playwright'ın CI'da çalışması (Chrome kanalı/tarayıcı kurulumu) ele alınmadı; yerelde Chrome gerekir.
- `net.*` metrik adlandırması (bayt/sn), `vite.config.ts` içindeki `__dirname` uyarısı (Vite `configLoader: native`), açık tema axe testi, grafikte canlı nokta ekleme.
- Üretim dağıtımı: statik sunum, CSP başlıkları, TLS (M6).
- Sıradaki: bağımsız M3b incelemesi (Critical 0 / Important 0) → bulgu düzeltmeleri → dar yeniden inceleme → ChatGPT özeti → birleştirme kararı.
