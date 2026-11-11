# Geliştirme ortamı: WSL2 + Ubuntu + Docker Desktop + TimescaleDB

Tarih: 2026-11-11 · Durum: **çalışıyor** (aşağıdaki doğrulamalar gerçek komut çıktılarına dayanır)

## Teşhis (systematic-debugging, Faz 1)
| Bulgu | Kanıt |
|---|---|
| Docker Desktop 4.99.0 kurucusu 13:01'de durdu | `%LOCALAPPDATA%\Docker\install-log.txt`: "Required Windows features are not enabled: VirtualMachinePlatform" (per-user kurulum, yönetici yetkisi yok) |
| Özellik şu an etkin | `Win32_OptionalFeature`: `VirtualMachinePlatform` = 1, `Microsoft-Windows-Subsystem-Linux` = 1; hypervisor çalışıyor (VBS/HVCI Running) |
| Bilgisayar özellik etkinleştirildikten sonra yeniden başlatılmış | Son açılış 14:00, kurucu denemesi 13:01 |
| WSL2 çalışıyor | Ubuntu 24.04 VM'i açıldı: çekirdek `6.18.58.1-microsoft-standard-WSL2`, çıkış kodu 0 |
| "WSL2 çalışmıyor" varsayımı | Bu açılışta **doğrulanamadı**; WSL2 hiçbir onarım gerektirmeden çalıştı |

**Sonuç (hipotez, kanıtla uyumlu ama kesin kanıtlanmadı):** Docker kurucusunun hatası, VirtualMachinePlatform'un yeniden başlatma öncesi durumundan kaynaklanıyordu. Hiçbir Windows güncellemesi kaldırılmadı, hiçbir sürücüye/BIOS/VBS/HVCI/Secure Boot ayarına dokunulmadı, bilgisayar yeniden başlatılmadı.

## Yapılan işlemler
1. Salt okunur teşhis (sürümler, servisler, WMI özellik durumu, Windows Update araması: 0 bekleyen güncelleme).
2. `wsl --install -d Ubuntu-24.04 --no-launch` (yönetici gerekmedi) → `Ubuntu-24.04`, VERSION 2. Kurulum sırasında okunamayan bir `ERROR_INVALID_DATA` uyarısı basıldı (çıkış UTF-16 olduğundan metni kaydedemedim); dağıtım yine de kuruldu ve soğuk açılışta uyarı tekrarlanmadı. **Açıklanamadı, zararsız görünüyor.**
3. `winget install Docker.DockerDesktop` (resmi paket, winget SHA-256 doğruladı) → UAC ile tüm kullanıcılar için `C:\Program Files\Docker\Docker`.
4. `docker desktop start` → motor 29.9.3, `docker-desktop` WSL dağıtımı Running/VERSION 2.
5. `docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d --wait db` → `deploy-db-1` healthy (`127.0.0.1:5432`). `deploy/.env` yalnızca yerel test değeri içerir ve git tarafından yok sayılır.

## Doğrulamalar (gerçek)
| Test | Sonuç |
|---|---|
| `wsl -d Ubuntu-24.04 -u root -- uname -a; os-release` | Ubuntu 24.04.5 LTS, WSL2 çekirdeği, 12 çekirdek, ~11,5 GB bellek, çıkış 0 |
| `docker info` | Sunucu 29.9.3, çekirdek WSL2, 12 çekirdek |
| Ana makineden `127.0.0.1:5432` TCP | Başarılı |
| `select version()` | PostgreSQL 16.6 |
| TimescaleDB | 2.17.2, **`SHOW timescaledb.license` = `timescale`** (sıkıştırma ve continuous aggregate açık) |
| Hypertable (1 gün chunk), 4612 satır insert | Başarılı |
| Aynı PK ile tekrar insert, `ON CONFLICT DO NOTHING` | `INSERT 0 0`, satır sayısı 4612 (değişmedi) |
| 2 chunk sıkıştırıldı, sıkıştırılmış chunk'a yinelenen satır insert | `INSERT 0 0`, satır sayısı 4612 (değişmedi) |
| Continuous aggregate (1 dk, avg/min/max/count), refresh | 4604 satır; politika ve 3 günlük saklama politikası eklendi |
| Test veritabanı `m0check` | Silindi |

## Proje planına etkisi
- Plan M0-3 Adım 2 (TimescaleDB lisans değeri) ve M2 B0 spike'ının iki sorusu (idempotent insert; continuous aggregate) **bu sürümde (2.17.2) olumlu** yanıtlandı. **Kapsam sınırı:** yalnızca *yinelenen* satırlar sıkıştırılmış chunk'a denendi; *yeni* satırın sıkıştırılmış chunk'a yazılması, RLS davranışı ve backfill + aggregate refresh penceresi hâlâ M2 B0'da test edilecek.
- Docker Desktop lisansı: Docker abonelik sözleşmesi geçerlidir (kişisel/küçük işletme kullanımı ücretsiz; büyük kuruluşlar için ücretli — **[Ön bilgi]**, güncel şartları docker.com'dan doğrulayın).
- Windows Update geçmişinde `2026-11 Dinamik Güncelleştirme (KB5132061, 26300.9974)` bu sabah **başarısız** (rc=4) görünüyor; şu an bekleyen güncelleme yok. WSL/Docker çalıştığı için bir engel değil, ancak ilerde kontrol edilmeli.

## Bilinmeyenler
- Docker'ın ilk sabahki hatasının kesin nedeni (yeniden başlatma öncesi durum hipotezi).
- Kurulumdaki `ERROR_INVALID_DATA` uyarısının metni.
- Yeniden başlatma sonrası Docker Desktop'ın kendiliğinden açılması ve oturum açma ayarı denenmedi.
- Ubuntu varsayılan kullanıcısı `root` (etkileşimsiz kurulum); gerekirse normal kullanıcı sonra eklenebilir.
