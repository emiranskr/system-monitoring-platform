# M1 Bağımsız Kod İncelemesi (2) — 2026-11-11

**Aralık:** `51aecdf..0de529b` (dal `feat/m1-review-batch-b`), ayrıca `src/` ve `installer/` altındaki tüm M1 kaynağının nihai hâli.
**Yöntem:** Salt okunur reviewer subagent. Önceki raporlar doğru kabul edilmedi, iddialar kod görüldükten sonra tek tek denetlendi. Ana çalışma ağacı değişmedi.
**Koşulan (ayrı worktree, sonra silindi):** Debug 145/145, Release 130/130; ikinci örnek konsol denemesi; 3 mutasyon ve 2 geçici deneme testi.
**Koşulmayan / doğrulanamayan:** installer betikleri, SCM/kurtarma davranışı, soak, gerçek ENOSPC, bellek ölçümü (private working set < 50 MB bu HEAD'de yeniden ölçülmedi).

## Sonuç

| Seviye | Bulgu sayısı |
|---|---:|
| Critical | 0 |
| Important | 4 |
| Minor | 11 |
| Informational | 10 |

**Karar:** Merge için "düzeltmelerle". Kabul kriteri (Critical = 0 **ve Important = 0**) **karşılanmadı**: 4 Important açık.

## Güçlü yanlar
- Protokol: gövdede `device_id` yok; kimlik `(spool_epoch, seq)`; batch yalnızca `ack_seq >= seq` ile silinir.
- Spool çökme sırası: append → fsync → state; açılışta `NextSeq` uzlaştırma ve yarım satır onarımı; gzip mühürleme `.tmp` → rename → ham silme, artık dosyalar açılışta ele alınıyor.
- Bellek yalnızca indeks + bir segment önbelleği; 2000 batch boşaltma ölçümü batch başına ~6,9 ms.
- Düşman yanıt savunması tutarlı: JSON tür kontrolleri, 1 MB sınır, yönlendirme kapalı, `server_time` ±366 gün, kültür-bağımsız biçim.
- TLS: pin uyuşmazlığı el sıkışmada reddedilir, token ve gövde gönderilmez; "doğrulamayı kapat" modu yok.
- Token deposu: DPAPI + içerik yazılmadan önce korumalı ACL, atomik değiştirme, içe aktarmada geri-okuma doğrulaması.
- Release'te `--allow-insecure-loopback` atar; CI Debug ve Release koşar.
- Installer: sanal hesap, miras kapalı veri ACL'i, çıkış kodu/pin/URL denetimi, `binPath` tırnak sorunundan kaçınma.
- Collector'lar birbirini düşürmez; takılan collector yeniden girilmez; NaN → null; PDH hatası bozulmuş moda geçer.

## Bulgular

### Critical
Yok.

### Important

**I-1. Süreç çıkış kodu her zaman 0; IMP-02 düzeltmesi gözlemlenemiyor.**
- Yer: `Program.cs:41` (`return 0;`), `AgentWorker.cs:29` (`Environment.ExitCode = 1`).
- Kanıt: veri dizini kilitliyken ikinci konsol örneği başlatıldı; `Start-Process -Wait` → `ExitCode = 0`. Günlükte "kilit alinamadi" satırı var.
- Neden: üst düzey ifadelerin `int` dönüşü `Environment.ExitCode`'u ezer (BackgroundService istisnasında da aynı ezme, kod okunarak çıkarıldı).
- Etki: kilit hatası, `Spool` kurucu hatası veya Release'te http `ArgumentException` ile kendini durduran servis "temiz durma" görünür. Kurulum betiği `sc failure` tanımlıyor ama `sc failureflag` yok, SCM sıfırdan farklı kodla zarif durmada yeniden başlatmaz (SCM tarafı test edilemedi).
- Test boşluğu: `HostTests` statik `Environment.ExitCode == 1` doğruluyor, süreç çıkış kodunu değil; ayrıca statiği 1'de bırakıyor.
- Öneri: `await host.RunAsync(); return Environment.ExitCode;`; `sc failureflag <ad> 1`; süreç düzeyinde test.

**I-2. `Spool.Enqueue`'da başarısız/yarım append, yeniden denenen sonraki batch'i sessizce kaybettirebilir.**
- Yer: `Spool.cs:116-129`; `SamplingPipeline.Flush` yeniden denemesi; kayıp yeri `Spool.cs:151-154` (`PeekOldest`).
- Akıl yürütme: başarısız `Write`/`Flush(true)` (disk dolu) `\n`'siz yarım satır bırakabilir; `seg.Bytes` ve `Refs` güncellenmez; pipeline örnekleri tutup yeniden dener; yeniden deneme aynı satıra eklenir ve geçersiz tek JSON satırı oluşur.
- Deneme (yalnızca kalıntı simüle edildi, gerçek ENOSPC üretilmedi): yarım satır eklendikten sonra `Enqueue`, ardından `Ack(a)` → `PeekOldest()` null, `DroppedBatches` 0, `PendingCount` 0; yeniden açılışta da 0.
- Etki: O1/O2 düzeltmelerinin hedeflediği disk-dolu toparlanma yolunda sessiz veri kaybı.
- Öneri: append hatasında dosyayı `seg.Bytes`'a kırp (veya satırdan önce her zaman `\n` yaz); `PeekOldest`'te düşen ref'leri say ve logla.

**I-3. Üretim bağlantısında yakalama yolu kayıpları görünmez.**
- Yer: `AgentWorker.cs:48-53`.
- `SamplingPipeline` `onError` olmadan kuruluyor, her `Enqueue` hatası (disk dolu, ACL, G/Ç) sessizce yutuluyor. `DroppedSamples`, `Uploader.RejectedSamples` ve `PeekOldest` ref düşmeleri hiçbir yerde yüzeye çıkmıyor.
- Etki: "onaysız verinin düşürülmesi sayılır ve loglanır" gereksinimiyle çelişir; veriyi yazamayan makine sağlıklı görünür.
- Öneri: `onError` bağla (durum değişiminde logla), reddedilen/düşen sayıları periyodik veya değişimde logla.

**I-4. Okunamayan token sessiz; A5 token denetimi artık boş (vacuous).**
- Yer: `AgentWorker.cs:82-83` (`ReadToken` `""` döner), `Verify-ServiceInstall.ps1:128-131`.
- Token geçidi kaldırılınca eksik/bozuk/ACL ile reddedilen token boş `Bearer ` başlığı üretiyor; yalnızca "sunucu kimlik bilgisini reddetti (401/403)" uyarısı çıkıyor, bu da teşhisi yanlış yönlendirir (en olası neden: `--import-token` `--token-reader "NT SERVICE\<ad>"` olmadan koşmak; installer içe aktarma yapmıyor).
- Doğrulama betiği hâlâ günlükte `'Korumali token deposu yok'` metninin **olmamasını** arıyor; kaynakta bu metni üreten kod kalmadı (`grep`: yalnızca betikte). "token okundu" satırı da yok. Denetim token okunsa da okunmasa da geçer.
- **Sonuç:** `docs/ilerleme/kanit/a5-son-kod.log` içindeki "servis hesabı token'ı okuyabiliyor" GECTI kaydı DPAPI/ACL okuma yolunu kanıtlamaz. (Not: bu oturumda verdiğim A5 raporunda bu kontrolü kanıt saydım; bu doğru değildi.)
- Öneri: `TryLoad` başarısızlığını durum değişiminde yol ve nedenle logla; doğrulama betiği olumlu sinyal arasın (ör. test sunucusunda kimlik doğrulamalı istek veya ilk başarılı yükleme log satırı).

### Minor

- **M-1.** `server_time`'sız/kullanılamaz 409 veya `ack_seq < seq` 200 yanıtı sonsuz yeniden dener (`Uploader.cs:104-108, 148`); zehirli sayaca girmez, ayırt edici log yok. Spool dolunca en eskiyi sayarak atar. Öneri: ofseti değiştirmeyen 409'ları say ve logla.
- **M-2.** Zehirli batch anlamı (`Uploader.cs:112-124`): 10 deneme backoff ile ~13 dk; dağıtım sırasında 404/405 ~13 dk'da bir batch kaybettirebilir. Araya giren geçici hata sayacı sıfırlamıyor ("ardışık" tam doğru değil). `AgentWorker.cs:67` metni "Spool kuyrugu temizlendi" yanlış (tek batch düşer). Öneri: asgari süre eşiği, 404/405'i hariç tut.
- **M-3.** Yaş sınırı ileri saat sıçramasında gerçek veriyi atar (`Spool.cs:206`, düzeltilmemiş `_now()`); >24 sa sıçrama son segment hariç hepsini düşürür (sayılır ve loglanır ama veri gider). Öneri: monotonik yaş veya birkaç ardışık doğrulama.
- **M-4.** Installer hizmeti önce LocalSystem/Automatic oluşturup sonra dönüştürüyor (`Install-SysMonService.ps1:79-83`); sonraki adım atarsa servis LocalSystem kalır ve yeniden başlatmada çalışır. Veri dizini ACL'i daha da geç (93-95). Düşük olasılık ama "asla LocalSystem" değişmezini ihlal eder. Öneri: `sc create ... obj=` atomik, ya da Disabled oluştur ve en son etkinleştir, ya da `catch`'te geri al.
- **M-5.** Diğer installer sertleştirmesi: `-Server http://...` betik doğrulamasından geçer ama Release servis `Uploader` kurucusunda çöker (I-1); `ServiceName`/`InstallDir` doğrulanmıyor, `$Server` tırnaklarıyla `ImagePath`'e, `ServiceName` `cmd /c`'ye ekleniyor; `ProgramData\SysMon` varsayılan ACL ile oluşuyor, düşük yetkili kullanıcının önceden oluşturduğu dizin için sahip/ACL kontrolü yok (`agent` yeniden adlandırılabilir); yükseltmede `-StartService` yoksa servis durmuş kalır; `failureflag` yok; `-RemoveData`'sız kaldırmada deterministik sanal hesap SID'i için ACE kalır.
- **M-6.** Saat ofseti her 200'de ölü bant olmadan uygulanır (`Uploader.cs:152, 183-189`); onlarca ms titreşim `ts`'i saniye sınırında kaydırır (biçim saniyeye keser), çakışma/boşluk olabilir; her ack'te ek fsync+rename. Öneri: eşik (ör. 2 sn) veya yumuşatma.
- **M-7.** Collector doğruluğu: `NetworkCollector` (`Collectors.cs:70`) `SanitizeUnique` yalnızca ASCII-dışı adları ayırır; temizlenince aynı olan ASCII adlar (`Eth (1)` / `Eth [1]`, 32 karakter sonrası farklılar) çakışıp üzerine yazar, yani O6 kısmen düzeltildi. `ICollector.Interval` `src`'de hiç okunmuyor; `DiskCollector` 5 sn bildirir ama saniyede çalışır.
- **M-8.** PDH ayrıntıları (`WindowsSources.cs:119-133`): `CStatus` `NEW_DATA`(1) değer yok sayılıyor; sıfırdan farklı her `PdhCollectQueryData` (`PDH_NO_DATA` dahil) sorguyu kapatıyor; `Dispose`, zaman aşımına uğramış ama hâlâ PDH içindeki görev varken `PdhCloseQuery` çağırabilir (kilit/iptal yok); "60 sn yeniden başlatma" yorumu son başlatmadan >60 sn geçmişse yanlış.
- **M-9.** Görev hataları servisi durdurmuyor: `Task.WhenAll(tasks)` (`AgentWorker.cs:78`) pipeline hata verirse yükleme döngüsü sürer, servis canlı ama örneklemiyor görünür (şimdilik pipeline hata veremiyor, örtük risk). `Uploader` kurucusu atarsa (Release + http) pipeline görevi başlamış olarak sahipsiz kalır ve örnek kilidi, hâlâ yazıyorken bırakılır.
- **M-10.** İstisna sınıfı boşlukları: `Spool.Enqueue`/`SaveState` yalnızca `IOException` yakalar (`Spool.cs:129`), `UnauthorizedAccessException` yayılır; `DeleteSegment`, segmenti listeden çıkardıktan sonra `IOException`'ı yutar, dosya yeniden açılışta dirilir (çift kayıt veya sınır aşımı); `InstanceLock.TryAcquire` yalnızca `IOException` yakalar, `agent.lock` erişim reddi temiz durma yolu yerine worker'ı çökertir.
- **M-11.** MIN-03 etkisiz (bkz. doğrulama tablosu ve test değerlendirmesi).

### Informational
- `new Uri(server, "/agent/v1/ingest")` `--server`'daki yol önekini atar; yol tabanlı ters proxy desteklenmez.
- Her TLS `AuthenticationException` 5 dk bekletir; geçici el sıkışma hataları dahil.
- DPAPI LocalMachine + statik entropy yalnızca dosya ACL'i kadar güçlü; dizinde yazma yetkisi olan biri saldırgan blob'u bırakabilir (M-5 ile bağlantılı).
- `HttpClient` hiç dispose edilmiyor (süreç çıkışında zararsız).
- SCM altında `Host.CreateApplicationBuilder` içerik kökü System32 olabilir (yalnızca isteğe bağlı `appsettings.json`'ı etkiler).
- Bellek hedefi (private working set < 50 MB) ADR 0003'te eski kodda ölçüldü, bu HEAD'de yeniden ölçülmedi, testle de doğrulanmıyor.
- Spool kilidi altında boşaltma, her peek'te (segment ayrıştırma) `Enqueue`'u bloklar; mevcut boyutlarda sorun değil.
- `ack_seq > seq` sessizce kabul edilir; yalnızca mevcut batch'i siler (zararsız) ama log hak ediyor.
- Analyzer yok, `TreatWarningsAsErrors` yok, kilit dosyası yok. Paket sürümleri güncel (Hosting 10.0.14, ProtectedData 10.0.14, xunit 2.9.3), lisanslar izin verici.
- Uzun disk-dolu sonrası çok büyük batch (en çok 20.000 örnek) 413 alıp sonunda zehirli olarak düşürülür.

## Önceki düzeltmelerin doğrulanması

| Madde | Durum | Kanıt / kapsayan test |
|---|---|---|
| K1 | DOĞRULANDI | `Spool.Ack` bulunamayan batch'te döner (`Spool.cs:167-168`); `K1_Ack_kuyrukta_olmayan_...`. Not: Ack, ack'lenen batch'ten öncekilerin tümünü siler; çağıran her zaman başı ack'lediği için doğru. |
| K2 | DOĞRULANDI | `MaxClockOffset` ±366 gün (`Uploader.cs:42, 187`), güvenli ayrıştırma; `K2_*` (9999-12-31, yanlış türler, tr-TR). Artık risk: yanlış sunucu `ts`'i 366 güne kadar kaydırabilir. |
| K3 | DOĞRULANDI | İndeks + tek segment önbelleği; `K3_Acilista_...` (`GC.GetTotalMemory` 3 MB eşiği). Test küresel duruma duyarlı ve diğer sınıflarla paralel koşar (MIN-03). |
| O1 | KISMEN | Pipeline yazma hatasına dayanıklı (`O1_*`, sahte sink ile). Gerçek `Spool`'da yarım yazma hâlâ veri kaybettirir (I-2); `onError` üretimde bağlı değil (I-3). |
| O2 | ÇÖKME/YENİDEN BAŞLATMA için DOĞRULANDI | `LoadSegments` yeni satır onarımı; `O2_...`. Süreç içi yeniden deneme için DÜZELTİLMEDİ (I-2). |
| O3 | DOĞRULANDI | `NextSeq` uzlaştırma (`Spool.cs:319-324`); `O3_Eski_state_json_...`. Kenar: tüm segmentler ack'lenmiş ve state bayatsa seq yeniden kullanılabilir. |
| O4 | RAPORLANAN DURUM İÇİN DOĞRULANDI | Tek segment koruması ve düşürme callback'i; `O4_*`. Artık: M-3. İlk O4 testinin sonundaki `Assert.Equal(b.Seq, b.Seq)` totoloji. |
| O5 | DOĞRULANDI | `CollectorRunner` `_inFlight`; `O5_Takilan_collector_...`. |
| O6 | KISMEN | Yalnızca ASCII-dışı adlar (M-7); `O6_*` kapsadığı kısım için doğru. |
| O7 | Yönlendirme: kodda var, **test boş**. Boyut: DOĞRULANDI. Ömür: kodda, test edilemez. | `AllowAutoRedirect=false` ve 1 MB sınır var. Yönlendirme testi `Location` başlıksız 307 gönderiyor; `AllowAutoRedirect=true` ile mutasyonda Release 130/130 geçti. Boyut testi sınırsız olsaydı kırılırdı. |
| O8 | DOĞRULANDI (M-2 uyarılarıyla) | `O8_*`. |
| O9 | KISMEN, koşulmadı | Çıkış kodu ve pin/URL denetimleri betikte okunarak görüldü; M-4, M-5 açık. |
| O10 | DOĞRULANAMADI | Depoda tanım bulunamadı. |
| O11 | DOĞRULANDI | Invariant kültür; `O11_...` (ar-SA, th-TH, fa-IR) ve `K2_Saat_dilimi_...` (tr-TR). |
| IMP-01 | DOĞRULANDI | `ValueKind` kontrolü (`Uploader.cs:136, 197`); `K2_409_yaniti_JSON_nesnesi_olmasa_...`. |
| IMP-02 | **İDDİA EDİLDİĞİ GİBİ DÜZELMEMİŞ** | Durdurma gerçekleşiyor ama süreç çıkış kodu 0 (I-1); `HostTests` yanlış şeyi doğruluyor. |
| MIN-01 | OKUNARAK DOĞRULANDI | `Install-SysMonService.ps1:31-33`; betikler test edilmiyor. |
| MIN-02 | DOĞRULANDI | `Uploader.cs:19` doc yorumu. |
| MIN-03 | **DÜZELTİLMEMİŞ** | `[Collection("NonParallelSpoolMemory")]` yalnızca bir sınıfta, `DisableParallelization` içeren `CollectionDefinition` yok; bellek ölçen test diğer sınıflarla paralel koşuyor. |

## Test kalitesi

**Boş veya zayıf testler**
- `O7_Yonlendirme_takip_edilmez_...`: `Location` başlığı yok; `AllowAutoRedirect=true` ile de geçer (mutasyonla doğrulandı).
- `O4_Tek_segmentte_...`: son iddia totoloji.
- `HostTests` kilit testi: süreç çıkış kodu yerine statik `Environment.ExitCode` (I-1).
- `K3`: süreç genelinde `GC.GetTotalMemory`, izolasyon iddiası yanlış.
- `Verify-ServiceInstall` token denetimi: her koşulda geçer (I-4).
- Soak zamanlayıcı tabanlı (40 ms aralık); yavaş CI'da kararsız olabilir.

**Mutasyon sonuçları**
- `ack < batch.Seq` kontrolü silindi → Release 130/130 geçti. Tek test (`Ack_seq_kucukse_...`) `UploaderTests` içinde ve o sınıf `#if DEBUG`.
- `Spool.ReadLines`'taki `InvalidDataException` yakalaması silindi → 27 Spool testi geçti. Kesik/bozuk gzip segmenti test edilmiyor.
- Release boşluğu: `UploaderTests` yalnızca Debug; Release'te 401/403→`AuthFailed`, `device_id` yokluğu, gzip/gövde alanı iddiaları testsiz. CI ikisini de koştuğu için Debug kapsıyor.

**Eksik senaryolar**
- Gerçek `Spool`'da başarısız/yarım append ve yeniden deneme (I-2).
- `Enqueue`/`Ack`/`PeekOldest` eşzamanlılığı (Spool için eşzamanlılık testi yok).
- Uçuştaki batch varken en eskiyi düşürme, `Uploader` üzerinden (K1 yalnızca spool düzeyinde).
- Epoch değişimi `Uploader` üzerinden.
- Kesik gzip segmenti.
- `server_time`'sız 409 döngüsü.
- Gönderilen seq'in üstünde `ack_seq`.
- Süreç çıkış kodu.
- İleri saat sıçraması.
- `PdhCollectQueryData` hatasından sonra PDH yeniden başlatma.
- Servis çalışırken token okuma hatası.
- Installer davranışı.

## Karara bağlanmayanlar
- SCM ve kurtarma davranışı (failure flag, yeniden başlatma süresi): servis kurmadan test edilemedi.
- Installer betiklerinin çalışma zamanı davranışı: yalnızca koddan.
- NTFS'te gerçek ENOSPC yarım yazma semantiği: sonuç simüle kalıntıyla gösterildi.
- Soak, gerçek zamanlı davranış ve bellek hedefi: koşulmadı.
- Sunucu tarafı protokol semantiği (boşluk toleransı, `ack_seq` kuralları): kapsam dışı.

## Düzeltme yapılmadı
Bu rapor yalnızca bulguları kaydeder. Kaynak kod, test ve installer'da hiçbir değişiklik yapılmadı; rapor dosyası commit'lenmedi.
