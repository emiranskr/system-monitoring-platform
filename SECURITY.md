# Güvenlik politikası

## Güvenlik açığı bildirme
Lütfen güvenlik açıklarını **herkese açık issue olarak açmayın**. GitHub'ın **Private vulnerability reporting** (Security → Report a vulnerability) özelliğini kullanın; bu etkin değilse depo sahibine GitHub üzerinden özel olarak ulaşın. Bildiriminize şunları ekleyin: etkilenen sürüm/commit, yeniden üretme adımları ve etki.

Hedefimiz: 7 gün içinde ilk yanıt, doğrulanan açıklar için makul sürede düzeltme ve (isterseniz) teşekkür notu.

## Kapsam
Bu bir geliştirme aşamasındaki projedir; **henüz kararlı bir sürümü ve desteklenen sürüm matrisi yoktur**. Kapsam: agent (`agent/`), API (`apps/api`), panel (`apps/web`), veritabanı migration'ları ve dağıtım örnekleri (`deploy/`).

## Tasarım güvenceleri (özet)
Tenant izolasyonu, SSRF koruması, AES-256-GCM (AAD'li) sır saklama, replay-güvenli veri girişi, sıkı CSP ve üretimde dev bayrağı reddi. Ayrıntı: [README → Güvenlik tasarımı](README.md#güvenlik-tasarımı), [docs/uyarilar.md](docs/uyarilar.md), [docs/uretim-dagitim.md](docs/uretim-dagitim.md).

## Bilinen doğrulanmamış alanlar
Kurulum paketi (Inno), gerçek donanım sensörleri (LibreHardwareMonitor/PawnIO), gerçek SMTP ve gerçek internete açık dağıtım **doğrulanmamıştır** ([README → Durum](README.md#durum-ve-bilinen-sınırlar)). Bu alanlarda bulduğunuz sorunlar da değerlidir.

## Sır yönetimi hatırlatması
`CHANNEL_KEY` ve `CREDENTIAL_KEY` anahtarlarını depoya koymayın; `.env` dosyaları `.gitignore` içindedir. Anahtar kaybı kanal sırlarının çözülememesi demektir ([docs/yedekleme.md](docs/yedekleme.md)).
