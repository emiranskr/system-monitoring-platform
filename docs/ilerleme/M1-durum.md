# M1 Durum Raporu — 2026-11-11

**Dal:** `feat/m1-review-batch-b` (taban: `feat/m1-agent` commit `51aecdf`)  
**Kod commit'i:** `cf70091` (doğrulama HEAD'i `d88d40d`)  
**Durum:** **M1 KAPANMADI.** Kod ve testler yeşil, A5 ve 10 dk soak son kodla doğrulandı. Bağımsız incelemenin son kod üzerindeki nihai raporu repoda yok; açık Critical/Important bulgu olmadığı henüz kanıtlanmadı. Merge ve kapanış kullanıcı onayı bekliyor.

---

## 1. Test Sonuçları (Gerçek ve Doğrulanmış)

| Konfigürasyon | Toplam Test | Başarılı | Başarısız | Atlanan | Süre | Not |
|---|---|---|---|---|---|---|
| **Debug** | **145** | **145** | **0** | **0** | ~10 sn | Tüm birim, entegrasyon ve loopback HTTP testleri dahil |
| **Release** | **130** | **130** | **0** | **0** | ~10 sn | Düz HTTP yasak; gerçek TLS Kestrel uçtan uca testleri dahil |
| **Outage Soak (Release, 10 dk kesinti)** | **1** | **1** | **0** | **0** | 13 dk 52 sn | HEAD `d88d40d`, `SYSMON_SOAK_REAL_TIMING=1`, baseline 60 sn, kesinti 600 sn. `SOAK_RAPOR`: kesintide biriken 105 batch, 661 örnek, 115 batch = 115 ham istek, **tekrar=0**, boşalma 170 sn, 11 retry, max bekleme 200,9 sn. Test örnek değerlerini benzersiz sayaçla kontrol ettiğinden kayıp/çift kayıt/seq boşluğu yok. Log: `docs/ilerleme/kanit/soak-10dk-son-kod.log` |
| **A5 Verify-ServiceInstall (Windows, yönetici)** | - | **BASARILI** | 0 | - | ~100 sn | HEAD `d88d40d`, Release yayını. Sanal hesap, PDH grup gerekliliği, ACL, token, kurtarma, temizlik: tüm kontroller GECTI. Log: `docs/ilerleme/kanit/a5-son-kod.log`. Temizlik ayrıca elle doğrulandı (servis/dizin/grup üyeliği/geçici dosya kalmadı) |
| **Publish (Release)** | - | **Başarılı** | **0** | - | 3 sn | `Agent.Service` derleme ve paketleme hatasız |

*Not:* Başlangıçta `feat/m1-agent` üzerinde 115 Debug / 100 Release testi mevcuttu. Bu çalışma kapsamında 30 yeni test eklenerek kapsam 145 Debug / 130 Release seviyesine çıkarılmıştır.

---

## 2. Tamamlanan ve Kanıtlanan Gözden Geçirme Maddeleri (Review Batch-B)

1. **InstanceLock (Tek Örnek Kilidi):**
   - Veri dizini başına `agent.lock` dosyası `FileShare.None` ile açılarak konsol ve servis modlarının çakışması ve spool'u bozması engellendi. Süreç sonlandığında OS kilidi bırakır.
   - `HostTests` ile kilit alındığında ikinci bir instance'ın çalışmadığı ve `lifetime.StopApplication()` ile temizce sonlandığı kanıtlandı.
2. **Uploader Güvenlik ve Hata Yönetimi (Ö7):**
   - `SocketsHttpHandler.AllowAutoRedirect = false` (HTTP redirect takibi engellendi, 3xx yanıtlarında ikinci hosta veri/istek gitmez).
   - `HttpClient.MaxResponseContentBufferSize = 1_048_576` (1 MB yanıt sınırı; 5 MB gibi aşırı büyük sunucu yanıtları tampon aşımı ile `Retry` döner, bellek taşmaz, spool onaylanmaz).
   - `PooledConnectionLifetime = 15 dk` (bağlantı ömrü sınırlanarak DNS güncellemelerine uyum sağlandı).
3. **Kültürden Bağımsız ISO-8601 Tarih Biçimi (Ö11):**
   - `Uploader.BuildContent`: `sent_at` ve örnek `ts` alanları `CultureInfo.InvariantCulture` ile formatlanır. `ar-SA` (Hicri), `th-TH` (Budist) ve `fa-IR` yerel ayarlarında Gregoryen ASCII ISO `yyyy-MM-ddTHH:mm:ssZ` formatı üretildiği test edildi.
4. **Server Time Offset Sınırı ve Güvenli Ayrıştırma (K2):**
   - `Uploader.TryGetServerTime` ve `TryApplyServerTime`:
     - JSON kök öğesinin nesne (`JsonValueKind.Object`) olduğu ve `server_time` alanının `String` olduğu doğrulandı (dizi, sayı, boolean tiplerinde istisna fırlatmaz).
     - Zaman damgası `CultureInfo.InvariantCulture`, `AssumeUniversal | AdjustToUniversal` ile UTC olarak çözülür.
     - Saat dilimi eki olmayan zaman damgaları yerel saat kayması eklenmeden UTC sayılır.
     - Ofset sınırı `MaxClockOffset = ±366 gün` olarak uygulandı. 9999 yılı gibi aşırı sunucu saatleri kuyruğu bozmaz ve yok sayılır. 200 OK ve 409 Conflict durumlarında geçerlidir.
5. **Zehirli Batch Yönetimi (Ö8):**
   - Aynı batch için ardışık 10 kalıcı 4xx (400, 404, 413, 422 vb.; 408, 429 ve 409 saat sapması hariç) yanıtı alındığında batch kuyruktan atılır (`_spool.Ack`).
   - `BatchDropped` olayı tetiklenir, `UploadOutcome.Acked` ile sonraki batch'e geçilir.
   - Geçici hatalar (5xx, 429, 408) batch'i asla atmaz.
   - Başarılı yükleme (200 OK) veya yeni batch gelmesi kalıcı hata sayacını sıfırlar.
6. **UploadRunner 401/403 Davranışı (AuthFailed):**
   - `UploadRunner.RunAsync` artık servisi kalıcı sonlandırmaz (`Task` döner).
   - `AuthFailed` durumunda `Backoff.Cap` (5 dk) beklenerek yeniden denenir. Cihaz token'ı sonradan aktarıldığında servis yeniden başlatılmadan yükleme hattı toparlanır.
7. **Komut Satırı Doğrulamaları (`AgentOptions`):**
   - `--server`: Mutlak URL, `http` (yalnızca debug loopback bayrağıyla) veya `https` şeması, `UserInfo` içermeme kontrolü.
   - `--server-pin`: `sha256/` öneki ve geçerli 32 bayt Base64 kontrolü.
8. **Worker ve Program Entegrasyonu:**
   - `AgentWorker.ExecuteAsync`: `await Task.Yield()`, `InstanceLock.TryAcquire`, token başlangıç kapısı kaldırıldı (boot anında token olmasa bile yükleyici başlar), `BatchDropped` ve Spool `onDropped` loglama.
   - `Program.cs`: Token import esnasında `CryptographicException` yakalanarak dostane hata mesajı ve çıkış kodu 1 sağlandı.
9. **PDH Collect Dayanıklılığı:**
   - `PdhCpuSource`: `PdhCollectQueryData` çağrısı başarısız olduğunda query handle'ı kapatılıp `Error` atanır; 60 sn sonra `TryInit` ile otomatik yeniden başlatılır.
10. **Servis Kurulum Betiği (`Install-SysMonService.ps1`):**
    - `sc.exe config obj=`, `sc.exe sidtype`, `sc.exe config start=` ve `sc.exe failure` komutlarının `$LASTEXITCODE` çıkış kodları denetlenir.
    - Yol parametrelerindeki boşluklar ve sondaki ters/düz bölüler temizlenir (`$DataDir.Trim().TrimEnd('\', '/')`).
    - `$Server` ve `$ServerPin` girdi doğrulamaları PowerShell düzeyinde de yapıldı.

---

## 3. Bağımsız Kod İncelemesi (Senior Code Review) Bulguları ve Giderilmesi

> **Doğrulama notu:** Aşağıdaki IMP/MIN bulguları commit `cf70091`'den alınmıştır. İncelemenin nihai raporu repoda bulunamadı; "açık Critical/Important kalmadı" iddiası son kod üzerinde yeniden yapılacak bağımsız incelemeyle doğrulanmalıdır (BEKLİYOR).

Aşağıdaki bulgular TDD ile giderildi:
- **IMP-01 (Düzeltildi):** 409 Conflict yanıtı dizi (`["conflict"]`) veya string (`"conflict"`) döndüğünde `JsonDocument.TryGetProperty` çağrısının `InvalidOperationException` fırlatması engellendi (`doc.RootElement.ValueKind != JsonValueKind.Object` kontrolü eklendi).
- **IMP-02 (Düzeltildi):** `InstanceLock` alınamadığında `AgentWorker`'ın arka planda asılı kalması engellendi; `IHostApplicationLifetime` enjekte edilerek `lifetime.StopApplication()` ve `Environment.ExitCode = 1` çağrıldı.
- **MIN-01 (Düzeltildi):** Kurulum betiği parametre temizliği `$Path.Trim().TrimEnd('\', '/')` olarak genişletildi.
- **MIN-02 (Düzeltildi):** `UploadOutcome.AuthFailed` XML doc comment güncellendi.
- **MIN-03 (Düzeltildi):** `SpoolReviewTests` sınıfına `[Collection("NonParallelSpoolMemory")]` eklenerek paralel test koşumlarındaki bellek ölçüm kırılganlığı giderildi.

---

## 4. Sonraki Adım: M1 Kapanışı ve M2 Hazırlığı

- Kalan: son kod üzerinde bağımsız inceleme (Critical/Important = 0 kanıtı), sonra kullanıcıdan merge ve M1 kapanış onayı.
- M2'ye ve merge'e kullanıcı onayı olmadan geçilmez.
