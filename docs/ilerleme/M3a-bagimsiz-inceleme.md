# M3a bağımsız inceleme (2026-11-15) — `caea950..52648e3`

**Sonuç: RET.** Critical 0, **Important 2**, Minor 4, Informational. Kabul ölçütü: Important = 0. Kod değiştirilmedi; düzeltmeler 2026-11-16 işi.

## Important (kapanmadan kabul yok)
### I-1 Oturum kapısı yüzde-kodlu / mutlak biçimli yolla atlatılıyor (`apps/api/src/session-guard.ts:48-49`)
Kapı ham `req.url`'in `/api/v1/` ile başlayıp başlamadığına bakıyor; Fastify yönlendiricisi yolu çözüp rotayı eşliyor.
- Oturumsuz: `GET /api/v%31/devices` → **500** (kapı atlandı, handler `req.session!`'te çöktü); `/%61pi/v1/devices`, `/api/%76%31/me`, `/api/v%31/stream`, mutlak biçim `GET http://x/api/v1/devices` de 500.
- `POST /api/v%31/logout` Origin başlıksız → **204** (CSRF Origin denetimi de atlanıyor).
- Şu an veri sızmıyor (handler'lar `req.session!` ile çöküyor) ama bu KAZARA; `req.session?.` kullanan/oturum okumayan her yeni rota açılır. Günlük de şişer.
- `idor.test.ts` bu sınıfı görmüyor (yalnız düz yollar).
- **Öneri:** kapıyı rota düzeyinde uygula (`/api/v1` önekli kapsüllenmiş eklenti veya `req.routeOptions.url` kontrolü) ya da yolu yönlendiriciyle aynı biçimde normalleştir. Kodlu yol için regresyon testi (yukarıdaki yolların hepsi 401/403 olmalı; 500 olmamalı).

### I-2 SSE `open` sayacı / abonelik / zamanlayıcı sızıntısı (`apps/api/src/stream.ts:32-37, 67-68`)
Sayaç `devices` süzgeci çözülürken değil sonra artıyor; `close` dinleyicileri en sonda ve senkron bağlanıyor. İstemci süzgeç çözümü sırasındaki `await`'lerde (50 cihaza kadar DB sorgusu) bağlantıyı keserse `close` olayı kaçıyor, dinleyici hiç tetiklenmiyor.
- Gerçek sunucuda 50 cihazlık süzgeçle 40 istek 2-21 ms sonra kesildi → `bus.size` = 3'e takıldı; aynı kullanıcıyla 4 temiz akış → **429 ×4** (süreç yeniden başlayana kadar kilitli). Tek cihazlık süzgeçte pencere dar ama var.
- **Öneri:** sayaç artışı ve dinleyici kaydını süzgeç çözümünden ÖNCE/atomik yap, ya da `req.raw.destroyed`/`res.destroyed` kontrolü ekle. Regresyon testi: "süzgeç çözülürken kesilen istek" sonrası sayaç/abonelik geri düşmeli.

## Minor
- **M-1** `ip inet` sütununa ham `req.ip` yazılıyor (`sessions.ts:25`, `users.ts:109`); bölge kimlikli link-local IPv6 (`fe80::1%eth0`) Postgres'te reddedilir → parola doğru olsa bile giriş 500 (eski oturum da iptal edilmiş olur). `ipKey` `%` kırpıyor, `createSession` kırpmıyor.
- **M-2** Hayatta kalan mutasyonlar: `loginPerIp` sınırlayıcısını silmek (`users.ts:92`) hiçbir testi kırmıyor; `stream.ts`'te `{ touch: false }` kaldırılınca 12 SSE testi geçiyor (karar yalnız `sessions.test.ts`'te birim düzeyinde kilitli) → ikisi için test ekle.
- **M-3** Her başarısız giriş bir `audit_events` satırı yazıyor (IP başına 60/dk), saklama politikası yok; süresi dolmuş hiç kullanılmamış `sessions` satırları yalnız erişimde siliniyor, temizleme işi yok. Büyüme yavaş ama sınırsız.
- **M-4** Belge-kod uyumu: (a) M3a.md §3 "ham sıkıştırma (12 sa) ham sorguya girmez" YANLIŞ: 12 sa–3 gün arasındaki sıkıştırılmış ham chunk'lar sorgulanabiliyor (ölçüldü: doğru, 601 nokta, 9 ms) → "anlamsız test" aslında gerçek bir yol, test ekle; (b) plan "online ≤ max(3×aralık,30 sn)" diyor, kod 6× (`devices.ts:15`), "benim kararlarım"da yok; (c) tasarım §10.5 "OrgContext, ham havuz dışa verilmez" için sonuç yok: handler'lar `pool.query`'yi doğrudan çağırıyor, izolasyon elle `orgId` + rota-kapsam testine dayanıyor; (d) ChatGPT şartı "argon2 ikilisi Windows+Linux CI'da doğrulanır" raporlanmadı (yalnız yerel Windows; Linux push sonrası CI'da); (e) bench geçmişi n=1/kova (n-ağırlık bench'te sınanmıyor), "2,56 M satır" betiğin ürettiği ~3,0 M'den az (muhtemelen 3 günlük saklama işi, doğrulanmadı).

## Informational
`POST /enrollment-tokens` gövdesiz 400 (istemci `{}` göndermeli); `?devices=a&devices=b` tekrarlı parametre süzgeci yok sayıp org'un tüm akışını açar (org dışına sızmaz); limiter tablo dolunca yeni anahtarları izlemiyor (M2 mirası); `verifyDummy` ilk çağrıda sahte özeti üretir (ilk istek yavaş); argon2 ve ingest gzip libuv havuzunu paylaşır, global giriş sınırı yok (çok-IP'li yük ingest'i yavaşlatabilir, teorik); HEAD `/stream` otomatik rotası akış açar ve sayaca girer; parola politikası yalnız uzunluk.

## Temiz çıkanlar
256 bit oturum kimliği + SHA-256, girişte oturum yenileme, çerez bayrakları; CSRF (null/alt alan/port/sonuna eklenmiş alan Origin'leri 403); tekdüze 401 + sabit maliyetli sahte hash; setup atomikliği (6 eşzamanlı → 1 başarı), token yalnız stderr; org izolasyonu (org istemciden alınmıyor, uniform 404, parametreli SQL); SSE org fan-out, yavaş tüketici, 135 sn açık akış (120 sn zaman aşımına takılmıyor); metrik sorgusu (sıfıra bölme/NULL kova yok, n-ağırlıklı ortalama doğru); ingest yayını COMMIT sonrası/hata yutan/replay yayınlanmaz; migration 0004; lisans (103 paket, 0 izinsiz).

## Doğrulama (inceleyici)
TS 14/21/247 geçti, lint temiz. Mutasyon: Origin denetimi kapatıldı → yakalandı; `requireRole` kaldırıldı → yakalandı; `loginPerIp` silindi → **hayatta kaldı**; `touch:false` kaldırıldı → **hayatta kaldı**. Bench yeniden koşulmadı; belge sayıları kanıt JSON'uyla uyumlu.

## Yarın (öncelik sırası)
1. **I-1** düzelt + regresyon testi (kodlu/mutlak yollar 401/403, 500 yok; idor.test.ts'e ekle). 2. **I-2** düzelt + regresyon testi. 3. M-1 (IP bölge kimliği), M-2 (iki mutasyon için test), M-4(a,b) belge/test düzeltmeleri; M-3 ertelenebilir (not düş). 4. Dar yeniden inceleme (yalnız düzeltme diff'i) → Critical 0 / Important 0 → ChatGPT özeti → birleştirme kararı → M3b.
