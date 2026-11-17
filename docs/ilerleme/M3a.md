# M3a — Kullanıcılar, Oturumlar, Okuma API'si, SSE (durum)

Tarih: 2026-11-15. Dal: `feat/m3a-backend` (taban `feat/m1-agent` @ `caea950`). Tasarım: `docs/superpowers/specs/2026-11-15-m3-auth-panel-design.md`; plan: `docs/superpowers/plans/2026-11-15-m3a-backend.md`. **Birleştirilmedi, push yok.** **Bağımsız inceleme yapıldı: RET (Critical 0, Important 2)** — ayrıntı ve yarınki iş sırası `docs/ilerleme/M3a-bagimsiz-inceleme.md`. I-1 (kodlu yolla oturum kapısı atlatma) ve I-2 (SSE sayaç/abonelik sızıntısı) kapanmadan M3a kabul edilmez. Aşağıdaki §3'teki "ham sıkıştırma" ifadesi YANLIŞTIR (bkz. inceleme M-4a).

## 1. Yapılanlar ve kanıtlar
| Görev | Çıktı | Kanıt |
|---|---|---|
| G1 | Migration `0004` (`users`, `sessions`, `setup_tokens`; bileşik FK; e-posta küçük harf tekil) | `packages/db/test/users.test.ts` (6) |
| G2 | argon2id (`@node-rs/argon2`, 64 MiB/t3, ölçüldü: ~45 ms/özet), sabit maliyetli sahte doğrulama | `password.test.ts` (6) |
| G3 | Oturum: 256 bit kimlik, DB'de yalnız SHA-256, 30 dk boşta / 12 sa mutlak, toplu iptal, `touch:false` | `sessions.test.ts` (13), 3 mutasyon yakalandı |
| G4 | `/api/v1` kapısı (çerez şart, genel yol allowlist), CSRF `Origin` denetimi, rol kısıtı, çerez biçimi | `session-guard.test.ts` (16), 2 mutasyon |
| G5 | İlk kurulum (setup token yalnız stderr'e bir kez, atomik tüketim), giriş/çıkış/`me`, tekdüze 401, IP+e-posta hız sınırı, audit | `setup-login.test.ts` (14), 3 mutasyon |
| G6 | Filo listesi (tek sorgu, N+1 yok), cihaz detayı, durum eşikleri, tekdüze 404 | `devices.test.ts` (18), 2 mutasyon |
| G7 | Metrik geçmişi (ham ≤3 sa / 1 dk katman, n-ağırlıklı kova, boşlukta nokta yok, doğrulama) | `metrics-query.test.ts` (26), 3 mutasyon (2'si ilk turda KAÇTI, testler güçlendirildi) |
| G8 | Enrollment token üretimi (admin/owner, ttl 5..1440 dk, tek gösterim, audit, hız sınırı) | `enrollment-admin.test.ts` (6), 2 mutasyon |
| G9 | SSE (`SampleBus`, org+cihaz fan-out, kullanıcı başına 3 akış, kalp atışı, 60 sn oturum yeniden doğrulama, replay yayınlanmaz) | `stream.test.ts` (12), 5 mutasyon (1'i ilk turda KAÇTI, IDOR testi güçlendirildi) |
| G10 | IDOR/org izolasyonu paketi + otomatik rota kapsam denetimi | `idor.test.ts` (10), 2 mutasyon |
| G11 | B-6 / SSE ölçümü | `tools/bench/query-bench.mjs`, `docs/ilerleme/kanit/m3a-query-bench-500cihaz.json` |

**Test toplamı:** TS protocol 14 + db 21 + api 247. (C# bu işte değişmedi; kapanış koşusu aşağıda.)

## 2. Ölçüm (ÖN ÖLÇÜM, resmi B-6 DEĞİL)
500 cihaz ingest yükü (5 sn/batch, ~100 istek/sn, 10 001 istek hepsi 200) SÜRERKEN, tek makine; geçmiş: 6 cihaz × 29 gün × 12 metrik (2,56 M ham satır), 1 dk katmanı eski chunk'ları sıkıştırılmış:
| Ölçüt | Sonuç | Bütçe |
|---|---|---|
| Grafik sorgusu 24 sa (1 dk katman) | p50 6,9 · **p95 9,1** · p99 21,9 ms | p95 < 500 ms |
| Grafik sorgusu ~28 gün (1 dk katman) | p50 10,2 · **p95 13,2** · p99 15,6 ms | p95 < 1000 ms |
| Grafik sorgusu 1 sa (ham) | p95 3,8 ms | — |
| Filo listesi (507 cihaz) | p50 38 · p95 47 ms | — |
| Ingest → SSE olay gecikmesi (sunucu katkısı) | p50 15 · **p95 24** · p99 37 ms | "örnekten ekrana" p95 < 10 sn'nin yalnız bir parçası |

**Dürüst sınırlar:** (1) Tek makine; yük üretici, API ve DB aynı yerde. (2) Geçmiş veri üretim ölçeğinin (500 cihaz × 30 gün ≈ 648 M katman satırı) çok altında; sorgu süreleri bu ölçekte **kanıtlanmadı**, yalnız tek-cihaz+metrik aralık okumasının küçük ölçekte hızlı olduğu gösterildi. Katman indeksleri/segmentby ölçekte ayrıca doğrulanmalı. (3) SSE rakamı yalnız sunucu katkısıdır; gerçek "örnekten ekrana" = agent örnekleme/batch yaşı (≤ batch aralığı) + bu gecikme + tarayıcı çizimi; son parça M3b'de ölçülecek. (4) 1 dk katmanı "yalnızca-materyalize" olduğundan son ~1-2 dk veri 24 sa/30 gün sorgusunda görünmez (ham veriyle ≤ 3 sa aralığında görünür). (5) Resmi B6 (30 dk/basamak) değildir.

## 3. Benim kararlarım (kontrol edilsin)
- İptal edilmiş (`revoked_at`) cihazlar listede `revoked` durumuyla görünür (gizlenmez).
- Giriş için ek `loginPerIp` (60/dk) ve `setupPerIp` (10/dk) sınırlayıcıları (planda yalnız IP+e-posta vardı).
- Oturum yeniden doğrulaması (SSE) `touch:false`: açık akış 30 dk boşta kuralını geçersiz kılmaz; SPA sayfayı canlı tutmak için `/api/v1/me`'yi periyodik çağırmalıdır (M3b).
- Setup token `process.stderr`'e yazılır (yapılandırılmış günlüğe değil; ChatGPT kararı, proposal §10.6'daki "günlüğe yazılır"ın yerine geçer).
- Metrik sorgusunda ham veri yalnız `to-from ≤ 3 sa` ve `from ≥ now-3 gün` için okunur. **DÜZELTME (inceleme M-4a):** önceki sürümdeki "12 sa sonrası sıkıştırılmış ham chunk ham sorguya girmez" ifadesi YANLIŞTI; 12 sa–3 gün arasındaki sıkıştırılmış ham chunk'lar da bu kuralla sorgulanabilir. Bu yol artık testli (`metrics-query.test.ts`, sıkıştırılmış chunk'ta doğru sonuç).
- **Cihaz durumu eşiği:** çevrimiçi sınırı `max(30 sn, 6 × örnekleme aralığı)` (planda 3× yazıyordu; 6× benim kararım, agent batch'i araya girdiğinde gereksiz "bayat" göstermemek için).
- **Org izolasyonu uygulaması:** tasarım §10.5'teki "OrgContext + ham havuz dışa verilmez" kuralı bu işte UYGULANMADI: handler'lar `pool.query`'yi doğrudan çağırır ve her sorgu elle `orgId` (oturumdan) geçirir; koruma, otomatik rota-kapsam testi + IDOR paketi + mutasyon denemeleridir. Yapısal (OrgContext) çözüm M6 sertleştirme adayı.
- **Linux/CI:** `@node-rs/argon2` ikilisinin Linux'ta çalıştığı bu işte DOĞRULANMADI (yalnız yerel Windows). Lock dosyasında platform ikilileri var; ilk push sonrası CI'da doğrulanmalı (ChatGPT şartı açık).
- **Bench notu:** geçmiş verisi dakikada 1 örnek (n=1/kova) olduğundan n-ağırlıklı ortalama bench'te değil birim testinde doğrulanır; betiğin ürettiği ham satır (~3,0 M) ile ölçülen (2,56 M) arasındaki fark (muhtemelen saklama işi) doğrulanmadı.
- **Ertelenen (inceleme M-3):** her başarısız giriş `audit_events` satırı yazar (saklama politikası yok) ve süresi dolmuş hiç kullanılmamış `sessions` satırları yalnız erişimde silinir (temizleme işi yok): büyüme yavaş ama sınırsız; saklama/temizleme işi M6 sertleştirmeye bırakıldı.
- `registeredRoutes` süsleyicisi yalnız IDOR kapsam testi için (`onRoute` kancası; çalışma zamanı maliyeti yok).

## 4. Düzeltmeler / yan bulgular
- **Lisans taraması M0'dan beri yalnız kök projeyi tarıyordu** (`-r` eksik): fastify/pg/zod gibi workspace bağımlılıkları taranmamıştı. Düzeltildi (`pnpm licenses list -r`), 103 paket 0 izinsiz; `docs/licenses.md` düzeltildi.
- `packages/db` testlerinde sıkıştırma politikası işiyle yarış (`compress_chunk` "already compressed") yalnız testte yutuldu; yükseltme testi yeni migration'lara dayanıklı yapıldı.

## 5. Açık / ertelenen
- **SSE yalnız tek API örneği için yeterli** (süreç-içi bus); çoklu örnek için LISTEN/NOTIFY veya kuyruk gerekir (belgelendi, `events.ts`).
- **M3b (React paneli)** başlamadı. `/api/v1/me` canlı tutma, OpenAPI üretimi, yazı tipi seçimi, axe testleri orada.
- M2'den taşınanlar: A5 servis doğrulaması (UAC), resmi 30 dk B6, B-5 kanıtı, `migrate()` 15 sn `statement_timeout`.
- Sıradaki: bağımsız M3a incelemesi (Critical 0 / Important 0) → ChatGPT özeti → birleştirme kararı → M3b.
