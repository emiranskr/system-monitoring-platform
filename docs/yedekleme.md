# Yedekleme ve geri yükleme (M6)

## Neyin yedeği alınır
| Varlık | Nerede | Yedek |
|---|---|---|
| Veritabanı (PostgreSQL + TimescaleDB) | `sysmon` veritabanı | `pg_dump -Fc` (aşağıda) |
| **`CHANNEL_KEY`** (bildirim kanal sırları anahtarı) | API ortam değişkeni | **Veritabanı yedeğinden AYRI ve güvenli** (parola yöneticisi/kasada). |
| **`CREDENTIAL_KEY`** | API ortam değişkeni | Aynı şekilde ayrı ve güvenli. |
| TLS sertifikası/anahtarı, `.env` | sunucu | Kendi sır yönetiminiz. |

> **Üç kritik gerçek (CHANNEL_KEY):**
> 1. Anahtar kaybolursa mevcut şifreli kanal sırları (webhook URL'si, imza sırrı, SMTP parolası) **çözülemez**; kanallar yeniden oluşturulmalıdır.
> 2. Veritabanı yedeği **tek başına yeterli değildir**: sırlar şifreli saklanır, anahtar yedekte yoktur. Anahtarı yedekten ayrı tutun (aynı yerde saklamak şifrelemenin amacını ortadan kaldırır).
> 3. Anahtar değiştirme / yeniden şifreleme **bu sürümde desteklenmez** (MVP dışı). Anahtar yalnız kaybolmasın diye yedeklenir; döndürülmez.

## Yedek alma (elle)
```bash
docker exec deploy-db-1 pg_dump -U sysmon -Fc -f /tmp/sysmon.dump sysmon
docker cp deploy-db-1:/tmp/sysmon.dump ./sysmon-$(date +%F).dump
```

## Geri yükleme (TimescaleDB'ye özgü sıra ÖNEMLİDİR)
Temiz, aynı TimescaleDB sürümünde (`2.17.2-pg16`) bir sunucuda:
```bash
createdb -U sysmon sysmon
psql -U sysmon -d sysmon -c "CREATE EXTENSION IF NOT EXISTS timescaledb"
psql -U sysmon -d sysmon -c "SELECT timescaledb_pre_restore()"
pg_restore -U sysmon -d sysmon --exit-on-error sysmon.dump
psql -U sysmon -d sysmon -c "SELECT timescaledb_post_restore()"
```
`pre_restore`/`post_restore` atlanırsa hypertable/continuous aggregate meta verisi bozulabilir.

## Otomatik tatbikat (kaynağa dokunmaz)
```bash
pnpm build
pnpm drill:backup
```
Betik (`scripts/backup-restore-drill.mjs`): çalışan geliştirme DB konteynerinde **geçici** bir veritabanı kurar, örnek veri (hypertable + continuous aggregate) basar, `pg_dump` alır, **temiz geçici bir konteynerde** yukarıdaki sırayla geri yükler ve tüm tabloların satır sayılarını, hypertable ve continuous aggregate listelerini karşılaştırır. Herhangi bir adım hata verirse veya görüntüler uyuşmazsa **çıkış kodu 1** döner; başarısız geri yükleme başarılı gösterilmez (`scripts/drill-lib.test.mjs` bunu sınar). Geçici konteyner ve veritabanı normal ve hata sonlanmalarında silinir (Ctrl-C ile kesilirse kalabilir: `docker ps -a` ile `sysmon-drill-*` konteynerini ve `sysmon_t_*` veritabanını elle silin). Ön koşul: Docker ve `deploy-db-1` konteyneri çalışıyor (`DOCKER_DB_CONTAINER` ile ad değiştirilir).

Son doğrulanan sonuç: 17 tablo, `metric_samples` 600 satır, `metric_samples` hypertable'ı ve `metric_1m` continuous aggregate'i kaynak ile geri yüklenen veritabanında aynı.

## Sınırlar (kapatılmış değil)
- Tatbikat örnek veriyle yapılır; gerçek üretim veri boyutunda süre/disk ölçülmedi.
- Tatbikat geliştirme Docker DB'sine karşıdır; üretim sunucusunda yedekleme zamanlaması, saklama ve şifreli saklama operatöre bırakılmıştır.
- Sürekli arşivleme (WAL/PITR) kapsam dışıdır.
