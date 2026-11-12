# M1 Important Bulguları (I-1…I-4 + installer M-4) Uygulama Planı

> **Uygulayıcı için:** Bu plan `executing-plans` veya `subagent-driven-development` ile görev görev uygulanır. Adımlar `- [ ]` ile izlenir. TDD: önce başarısız test, sonra kod.

**Amaç:** Bağımsız incelemedeki 4 Important bulguyu ve installer'ın LocalSystem penceresi riskini giderip Critical = 0 / Important = 0 kabul kriterine ulaşmak.

**Kaynak:** `docs/ilerleme/M1-bagimsiz-inceleme-2.md` (tüm bulgular bu oturumda kodda yeniden doğrulandı).

**Teknoloji:** .NET 10 (`net10.0-windows`), xUnit, PowerShell 5.1 installer betikleri.

## Doğrulanmış mevcut durum (kodda okundu, 2026-11-12)

- Dal `feat/m1-review-batch-b`, HEAD `0de529b`. Tek fark: izlenmeyen `docs/ilerleme/M1-bagimsiz-inceleme-2.md`. `feat/m1-agent` = `51aecdf`, dokunulmadı. `wip/m1-review-batch-b` = `dea38f7`. Başka worktree yok.
- **I-1 açık:** `Program.cs:41` `return 0;`, `AgentWorker.cs:29` `Environment.ExitCode = 1` ezilir.
- **I-2 açık:** `Spool.cs:116-129` yazma/Flush hatasında `seg.Bytes` güncellenmez, dosyada `\n`'siz kalıntı kalabilir; yeniden deneme aynı satıra eklenir. `PeekOldest` (`Spool.cs:151-154`) düşen ref'i saymaz/loglamaz.
- **I-3 kısmen açık:** Collector durum değişimi zaten loglanıyor (`AgentWorker.cs:49-53`). Eksik olan: `SamplingPipeline` için `onError` bağlı değil (`AgentWorker.cs:48`), `DroppedSamples`, `Uploader.RejectedSamples` ve `PeekOldest` ref düşmeleri hiçbir yerde yüzeye çıkmıyor.
- **I-4 açık:** `ReadToken` (`AgentWorker.cs:82-83`) hatada sessizce `""` döner. `Verify-ServiceInstall.ps1:128-131` artık hiçbir kodun üretmediği `'Korumali token deposu yok'` metnini arar; kontrol her koşulda geçer.
- **Installer açık (M-4):** `Install-SysMonService.ps1:79-83` `New-Service` ile LocalSystem + Automatic oluşturur, sonra `sc config obj=` ile dönüştürür; arada hata olursa servis LocalSystem/Automatic kalır.

## Genel kısıtlar
- `feat/m1-agent`, `main`, `wip/*`, `feat/m0-foundations` değişmez. Merge/cherry-pick yok.
- Mevcut testler ve `docs/ilerleme/kanit/*` korunur.
- Çalışma: onay sonrası `feat/m1-review-batch-b` HEAD'inden yeni dal `fix/m1-important-bulgulari` (öneri). Her görev ayrı commit.
- Proje dışındaki (kullanıcı profili altındaki) dosyalara dokunulmaz.

## Görevler (sırayla)

### Görev 1 — I-1: süreç çıkış kodu
**Dosyalar:** `src/Agent.Service/Program.cs:39-41`; yeni test `tests/Agent.Tests/ProcessExitCodeTests.cs`.
- [ ] Test: `Ikinci_ornek_ayni_veri_dizininde_cikis_kodu_1_ile_biter` — `Agent.Service.exe`'yi gerçek süreç olarak aynı `--data-dir` ile iki kez başlatır (birincisi çalışırken); ikincinin `ExitCode == 1`, birincinin kilidi korunur. Debug ve Release.
- [ ] Test: `Gecersiz_arguman_cikis_kodu_2` (zaten 2 dönüyor; regresyon kilidi).
- [ ] Kod: `await host.RunAsync(); return Environment.ExitCode;`
- [ ] `HostTests` kilit testindeki statik `Environment.ExitCode` iddiasını koru ama sonunda `Environment.ExitCode = 0` ile sıfırla (diğer testlere sızmasın).
- [ ] Kurulum: `Install-SysMonService.ps1`'ye `sc.exe failureflag $ServiceName 1` (çıkış kodu denetimli) — SCM sıfırdan farklı zarif durmada da yeniden başlatsın.
- Başarı: yeni testler önce KIRMIZI (süreç kodu 0), sonra yeşil.

### Görev 2 — I-2: Spool yarım yazma
**Dosyalar:** `src/Agent.Transport/Spool.cs` (`Enqueue`, `PeekOldest`); test `tests/Agent.Tests/Transport/SpoolPartialWriteTests.cs`.
- [ ] Test: `Yarim_satir_kalintisindan_sonra_yeniden_Enqueue_batch_kaybetmez` — segment dosyasına `\n`'siz kalıntı ekle (dosyayı dışarıdan yaz), `Enqueue(b2)`, `PeekOldest`/`Ack` ile `b2`'nin okunabildiğini, `PendingCount == 1` ve `DroppedBatches == 0` olduğunu doğrula; yeniden açılışta aynı.
- [ ] Test: `Yazma_hatasinda_dosya_son_gecerli_boyuta_kirpilir` — `Enqueue` sırasında yazma hatası enjekte edilebilen küçük bir dikiş noktası (ör. `Spool` kurucusuna isteğe bağlı `Func<string, FileMode, Stream>` yok; bunun yerine segment dosyasını salt okunur tutup `IOException` üretmek). Başarısız çağrıdan sonra dosya boyutu `seg.Bytes`'a eşit.
- [ ] Test: `Okunamayan_ref_dusurulunce_sayilir_ve_bildirilir` — `PeekOldest` düşen ref'i `DroppedBatches`'e ekler ve `onDropped` çağrılır.
- [ ] Kod: `Enqueue` içinde yazma `try/catch`; hatada dosyayı `seg.Bytes` uzunluğuna kırp, istisnayı yeniden fırlat (ayrıca `UnauthorizedAccessException` da kapsanır, M-10). Yazmadan önce dosya `\n` ile bitmiyorsa önüne `\n` ekle (savunma). `PeekOldest`'ta düşen ref'i `DroppedBatches`'e ekle ve `onDropped(1)` çağır.
- Başarı: ilk test önce KIRMIZI (inceleme denemesiyle aynı sonuç: `PeekOldest` null), sonra yeşil; tüm Spool testleri yeşil.

### Görev 3 — I-3: kayıpları görünür kıl
**Dosyalar:** `src/Agent.Service/AgentWorker.cs:48-67`; test `tests/Agent.Tests/PipelineRobustnessTests.cs` (genişlet) ve `HostTests`.
- [ ] Test: `Enqueue_hatasi_onError_ile_bildirilir_ve_hat_calismaya_devam_eder` (mevcut O1 testi `onError` kontrolü yapıyor; üretim kablolamasını `AgentWorker` üzerinden doğrulayan bir ana bilgisayar testi ekle: Spool dizini yazılamaz yapılınca günlükte hata satırı var).
- [ ] Kod: `onError` bağla (aynı hata mesajı art arda tekrarlanıyorsa yalnız değişimde/en çok dakikada bir logla). 60 sn aralıklı bir "sağlık" satırı: `DroppedSamples`, `Uploader.RejectedSamples`, `spool.DroppedBatches` değiştiyse `LogWarning`.
- [ ] `AgentWorker.cs:67` metnini düzelt: "Zehirli batch atildi … (tek batch)"; "Spool kuyrugu temizlendi" ifadesi kalkar.
- Başarı: hata enjekte edilen çalıştırmada günlükte hem hata hem sayaç satırı görülür.

### Görev 4 — I-4: token okuma kanıtı
**Dosyalar:** `src/Agent.Service/AgentWorker.cs:82-83`; `installer/Verify-ServiceInstall.ps1:126-132`; test `tests/Agent.Tests/TokenReadLoggingTests.cs`.
- [ ] Test: `Token_okunamazsa_durum_degisiminde_bir_kez_loglanir` ve `Token_okununca_Token_yuklendi_satiri_bir_kez_yazilir` — `ReadToken` mantığını küçük bir sınıfa (`TokenProvider`, `Func<string>` + `Action<string>` log) çıkar; art arda başarısızlık tek satır, başarıya dönüşte tek "yüklendi" satırı.
- [ ] Kod: `TokenProvider` (boş dönüş yerine durum izler: Yok/Bozuk/Erişim reddi → neden ve yol loglanır, token değeri ASLA loglanmaz).
- [ ] `Verify-ServiceInstall.ps1`: aşama 3'te olumlu sinyal ara — günlükte `Token yuklendi` satırı; ek negatif kontrol: token İÇE AKTARILMADAN çalıştırılan aşamada `Token okunamadi` satırı beklenir (kontrolün boş olmadığını kanıtlar). Eski `'Korumali token deposu yok'` kontrolünü kaldır.
- Başarı: A5'te "Token yuklendi" yalnızca import sonrası görünür.

### Görev 5 — Installer: LocalSystem penceresi (M-4)
**Dosyalar:** `installer/Install-SysMonService.ps1:75-110`; `installer/Verify-ServiceInstall.ps1` (yeni aşama).
- [ ] Kod: Yeni servis `-StartupType Disabled` ile oluşturulur; tüm yapılandırma (`obj=`, `sidtype`, `failure`, `failureflag`, ACL) `try` içinde; `catch`'te yeni oluşturulan servis silinir (`sc delete`) ve hata yeniden fırlatılır; en son `start= delayed-auto` ayarlanır. Böylece hiçbir an LocalSystem + Automatic yok.
- [ ] A5'e aşama: geçersiz `-DataDir` (ör. olmayan sürücü `Z:\x`) ile kurulumu bilerek başarısızlığa uğrat; sonra `Get-Service` ile servisin kalmadığını (veya en azından LocalSystem/Automatic OLMADIĞINI) doğrula.
- [ ] (Aynı görevde, küçük) `-ServiceName` `^[A-Za-z0-9_-]{1,64}$` doğrulaması; `-Server` Release için yalnız `https` (M-5).
- Başarı: A5 yeni aşama GECTI; normal kurulum aşamaları değişmeden GECTI.

### Görev 6 — Boş çıkan testler (öneri; Important kapsamı dışı ama mutasyonla kanıtlandı)
- [ ] `O7_Yonlendirme…`: `TestHttpsServer`'a `Location` başlığı seçeneği; ikinci bir hedef sunucuya istek GİTMEDİĞİNİ doğrula; `AllowAutoRedirect=true` mutasyonunda KIRMIZI olduğunu göster.
- [ ] `Ack_seq_kucukse_…` testini Release'te de koşacak şekilde `#if DEBUG` dışına al veya eşdeğerini ekle (`ack < seq` mutasyonunda KIRMIZI).
- [ ] Kesik gzip segmenti testi (`InvalidDataException` yakalaması mutasyonunda KIRMIZI).
- [ ] MIN-03: `[CollectionDefinition("NonParallelSpoolMemory", DisableParallelization = true)]` ekle.

## Doğrulama (kanıt toplanır, "bitti" demeden önce)
1. Her görevde: test önce KIRMIZI (çıktı kaydı), kod sonrası YEŞİL.
2. Komutlar (repo kökünden):
   - `dotnet test agent/windows/SysMon.Agent.sln -c Debug` → 0 başarısız
   - `dotnet test agent/windows/SysMon.Agent.sln -c Release` → 0 başarısız
3. Yeniden yayın + A5: `dotnet publish … -c Release`, UAC ile `Verify-ServiceInstall.ps1` → `BASARILI`; log `docs/ilerleme/kanit/a5-fix-sonrasi.log` (eski kanıt dosyaları korunur).
4. `Spool.Enqueue` veri yolu değiştiği için: hızlı soak (varsayılan) ve bir kez 10 dk gerçek zamanlı soak (`SYSMON_SOAK_REAL_TIMING=1 … OUTAGE_SECONDS=600`) → 0 kayıp, 0 tekrar, seq boşluksuz. Log `docs/ilerleme/kanit/soak-10dk-fix-sonrasi.log`.
5. Kapsamı sınırlı yeniden inceleme: yalnızca bu dalın diff'i (`0de529b..HEAD`) için tek reviewer; Critical = 0 ve Important = 0 beklenir. Tüm M1'i yeniden incelemeyiz.

## M1'i kapatmak için kalan kesin işler
1. Görev 1-5 (+ önerilen Görev 6) uygulanır, Debug/Release/A5/soak kanıtları toplanır.
2. Kapsamı sınırlı yeniden inceleme: Critical = 0, Important = 0.
3. `docs/ilerleme/M1-durum.md` ve `M1.md` gerçek kanıtlarla güncellenir; `M1-bagimsiz-inceleme-2.md` commit'lenir (şu an izlenmiyor).
4. Sizin açık onayınızla: `fix/m1-important-bulgulari` → `feat/m1-review-batch-b` → `feat/m1-agent` birleştirme sırası ve M1 kapanışı. (Ben bu birleştirmeleri onay olmadan yapmam.)
5. Ardından M2 (Backend) ve M3 (Web Dashboard).

## Harici geri bildirim (ChatGPT, tavsiye niteliğinde; değerlendirme)
Planın özeti ChatGPT'ye gönderildi; yanıt "plan doğru, sıra mantıklı" yönünde. Öneriler tek tek değerlendirildi:

**Plana EKLENİR (düşük maliyet, değerli):**
- Görev 1 testi: ilk sürecin de çalışmaya devam ettiğini ve ikinci süreç çıkınca kilidin serbest kaldığını doğrular.
- Görev 2 testleri: **restart recovery** (yarım satır kalıntısıyla kapanıp yeniden açılışta kayıp yok) ve **idempotency** (aynı batch'in yeniden kuyruğa alınması çift kayıt üretmez). Başarısız yazma, daha önce kaydedilmiş batch'leri bozmaz.
- Görev 3: sayaçların kümülatif mi sıfırlanan mı olduğu kodda ve testte açık yazılır (kümülatif); log yazma hatası pipeline'ı durdurmaz.
- Görev 4: token sonradan erişilebilir olunca yeniden yüklenir (test); okunamazken boş `Bearer` gönderilmez, istek yapılmaz (şu an boş Bearer gidiyor; düzeltme bunu da kapsar).
- Görev 5: kurulum sonunda hesap/başlangıç türü/izin doğrulaması ve başarısız kurulumda yarım dosya temizliği + yeniden kurulabilirlik (A5 aşamasına eklenir).
- Görev 6 (boş testler) **zorunlu** hâle getirilir; mutasyonla boş oldukları kanıtlandı.
- Soak raporunda kesinti öncesi/sırası kuyruk ve batch sayıları ile sunucu tarafı benzersiz `(epoch, seq)` sayısı ayrıca yazılır (test sunucusu zaten sayıyor).

**Eklenmez (gerekçe):**
- Gerçek ENOSPC / ani güç kesintisi testi: yeniden üretilebilir şekilde otomatikleştirilemez; yarım satır kalıntısı simülasyonu ve restart recovery testi aynı hata sınıfını kapsar. Sınır dokümante edilir.
- `sc failureflag` etkisini SCM'de uçtan uca kanıtlama: A5'te `sc qfailureflag` çıktısı doğrulanır, fiilî yeniden başlatma davranışı ayrı bir zorlama testi gerektirir ve kapsam dışı bırakılır.
- Bağımsız yeniden inceleme "yalnızca bu diff" kapsamı korunur (ChatGPT'nin "tüm bulguları yeniden doğrula" eğilimi gereksiz tekrar olur).

## Kendi kontrolüm (self-review)
- Kapsam: I-1…I-4 ve M-4 görevlerle eşleşti; M-1…M-3, M-6…M-11 bilinçli olarak dışarıda (Important değil); isterseniz M2 öncesi ayrı bir "sertleştirme" görevine alınabilir.
- Belirsiz nokta: Görev 2'deki yazma hatası enjeksiyonu için en az müdahaleli yol (salt okunur dosya ile gerçek `IOException`) seçildi; üretim koduna test dikişi eklenmedi.
- Risk: Görev 5 PowerShell 5.1 davranışına bağlı; doğrulama gerçek Windows'ta A5 ile yapılır.
