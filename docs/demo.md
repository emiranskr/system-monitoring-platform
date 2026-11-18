# Sergi / demo verisi (yerel)

Tek komutla yerel geliştirme veritabanına inandırıcı bir demo organizasyonu basar (`scripts/demo.mjs`). **Yalnız yerel demo içindir**; üretim veritabanına karşı çalıştırmayın.

## Hızlı başlangıç
```bash
docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d --wait
pnpm build
pnpm demo            # yalnız tohum (veri bir kez basılır)
```
API ve paneli başlatın ([web-kurulum.md](web-kurulum.md) §1), sonra panelin **canlı akması** için:
```bash
pnpm demo:live       # tohum + API'ye 5 sn'de bir canlı ölçüm (Ctrl-C ile durur; API http://127.0.0.1:8443 varsayılan, --api <url> ile değişir)
```
Giriş: `http://localhost:5173/giris`, e-posta `demo@example.com`. **Parola her çalıştırmada rastgele üretilir ve yalnız komutun çıktısında yazar** (depoda sabit parola yoktur).

## Ne basılır
- **5 cihaz:** `ofis-pc-01` (normal), `tasarim-ws-gpu` (GPU: kullanım, VRAM, sıcaklık), `sunucu-01` (yüksek CPU + disk %92), `laptop-ahmet` (3 saattir çevrimdışı), `yeni-cihaz` (hiç veri göndermemiş).
- **27 saatlik geçmiş:** son 3 saat 15 sn aralıklı, öncesi 1 dk aralıklı (CPU, bellek, disk, ağ, GPU); deterministik dalgalanma.
- **Uyarılar:** "Demo: yüksek CPU" kuralı, 1 çözülmüş geçmiş olay ve `sunucu-01` için açık kritik olay. API açıkken yerleşik kurallar da çalışır: `laptop-ahmet` için **"Cihaz çevrimdışı" olayı API başladıktan yaklaşık 6 dk sonra** (grace süresi) kendiliğinden oluşur.
- Bildirim kanalı **basılmaz** (kanal sırları `CHANNEL_KEY` ile şifrelenir): Uyarılar → Kanallar'dan ekleyin.

## Notlar
- Tekrar çalıştırmak **yalnız demo organizasyonunun** verisini sıfırdan kurar; diğer organizasyonlara dokunmaz.
- Sürekli gönderim için `pnpm demo:live` çalışır durumda kalmalıdır; durursa cihazlar bir süre sonra "bayat/çevrimdışı" görünür.
- Veriler sentetiktir; gerçek donanım ölçümü değildir (sergide böyle söyleyin).
