# M1 Dar Kapsamlı Bağımsız İnceleme (3) — 2026-11-12

**Aralık:** `0de529b..0db33a8` (dal `fix/m1-important-bulgulari`). Salt okunur reviewer subagent; kodu okudu, test/derleme/installer **koşturmadı** (soak çalışıyordu).
**Sonuç:** Critical **0**, Important **0**, Minor **6**, Informational **2** (+ N-9 listesi). Reviewer kararı: birleştirmeye hazır, "Evet".

## Doğrulama tablosu
| ID | Karar | Kanıt |
|---|---|---|
| I-1 | DÜZELDİ | `Program.cs:42` `Environment.ExitCode` döner; `ProcessExitCodeTests` gerçek exe çalıştırır. SCM'in kodu görüp görmediği doğrulanmadı (N-7). |
| I-2 | DÜZELDİ | `Spool.AppendDurably`: `OpenOrCreate`, `Length != Bytes` ise `SetLength(seg.Bytes)`, sonra yaz+fsync. `Segment.Bytes` değişmezi yeni/yüklenen/mühürlü/başarısız-append durumlarında tutuyor. `PeekOldest` düşen ref'i sayar ve bildirir. Kalan kenar durum: N-2. |
| I-3 | DÜZELDİ | `onError: loss.ReportError`, 60 sn'lik `LossLoop` ve çıkışta son kontrol; `LossReporter` iş parçacığı güvenli, log hatasını yutar. |
| I-4 | DÜZELDİ | `TokenProvider.Get` hatada boş döner, eski değeri tutmaz, değeri loglamaz; `Uploader` boş token'da istek kurmadan `AuthFailed` döner. |
| M-4 | DÜZELDİ (taze kurulum), KISMEN (yükseltme) | Disabled oluştur → try içinde yapılandır → `delayed-auto` en son → hata halinde geri al. Yükseltme yolu için N-1. |

## Minor
- **N-1** `Install-SysMonService.ps1`: `$addedGroup` `MemberExistsException` durumunda da `$true` olur; yükseltmede geri alma, önceden var olan üyeliği siler. Yükseltme yolunda eski `StartMode`/`ImagePath` geri yüklenmez (hata sonrası servis Disabled kalır, fail-safe). Öneri: `$addedGroup` yalnızca gerçekten eklenince; eski değerleri kaydet/geri yükle.
- **N-2** `Spool.cs:142` `AppendDurably`: dosya `seg.Bytes`'tan kısaysa (dışarıdan silme/kırpma) `SetLength` NUL ile uzatır; ilk yeni satır NUL+JSON olur, batch dosyada geçersiz kalır. Eski `FileMode.Append` doğru yazardı. Öneri: `fs.Length < seg.Bytes` ise `seg.Bytes = fs.Length` yap (gerekirse `\n` ekle).
- **N-3** `AgentWorker.cs:37`/`Spool.cs:173`: `onDropped` mesajı "boyut veya yaş sınırı" diyor; `PeekOldest` kaynaklı düşmelerde yanlış neden. Öneri: ayrı geri çağrı/mesaj.
- **N-4** `Verify-ServiceInstall.ps1:165-166`: hata üyelik eklenmeden (adım 4) çıktığından "üyelik geri alındı" kontrolü boş geçer; kurulumdaki catch-içi `Remove-LocalGroupMember` A5'te hiç çalışmaz. Servis/dizin geri alma ve yeniden kurulabilirlik gerçekten kanıtlanıyor. Öneri: adım 5'ten sonra hata üret (ör. bozuk `Agent.Service.exe` ile `-StartService`).
- **N-5** `HostTests` I-3 testi, segment dosyası oluştur+yaz+fsync penceresinde `FileShare.None` açılırsa aralıklı kırılabilirdi. **Sonradan giderildi** (kilit alma `WaitUntil` ile yeniden denenir).
- **N-6** `Install-SysMonService.ps1:83-85`: ham `$Server` ve dizinler `ImagePath`'e kaçışsız eklenir (yönetici girdisi, sertleştirme); `-ServiceName` regex'inde `$` yerine `\z` kullanılmalı.

## Informational
- **N-7** `failureflag`, SCM'e bildirilen çıkış koduna bakar; .NET Windows-service ana bilgisayarının `Environment.ExitCode`'u iletip iletmediği doğrulanmadı. İletiyorsa kilit hatasında 60 sn'de bir yeniden başlama olur.
- **N-8** Boş token `AuthFailed` döner, `UploadRunner` 5 dk (`Backoff.Cap`) bekler; sonradan aktarılan token en geç ~5 dk sonra kullanılır (regresyon değil).
- **N-9** `File.Exists` ACL-erişim-reddinde "yok" der; üç sayaç kilitsiz okunur (64-bit'te atomik); `SaveState` yalnızca `IOException` yakalar (mevcut, çift batch riski); `ReportError` ilk hatadan sonra durursa bastırılan sayı bildirilmez; A5 token değerinin `agent.log`'da olmadığını doğrudan grep'lemiyor; `GroupLineCount` `net` hata verirse boş geçebilir; Uninstall üyeliği servis durdurma/silmeden önce kaldırır (sonraki adım başarısızsa servis PDH hakkı olmadan kalır).

## Test kalitesi notları (reviewer)
- `Basarisiz_Enqueue_dosyayi_bozmaz...`: hata `FileStream` kurucusunda (try dışı) oluştuğundan eski kodda da geçerdi; yalnızca seq sürekliliğini korur. Catch-içi kırpma dalına mid-write hatası enjekte eden test yok (dal pre-trim ile örtüşüyor, kusur değil).
- `Yeniden_acilista_...` testinin adı "restart recovery" der ama kalıntı kapanıştan önce kırpılır; yükleme onarımı eski O2 testiyle kapsanır.
- `ProcessExitCodeTests`, exe'yi `src\Agent.Service\bin\<cfg>\<tfm>` altından alır; yalnızca test projesi derlenirse bayat exe kullanılabilir (mevcut proje referansıyla sorun yok).

## Karara bağlanmayan
SCM'in `failureflag`'i `Environment.ExitCode` ile onurlandırması; PS 5.1'de tipli `catch [MemberExistsException]` (A5'in tekrarlı `Install -Perf` geçişi dolaylı kanıt); Inno Setup sarmalayıcısı ve plan/rapor dokümanları; `Set-ItemProperty ImagePath` kayıt defteri değer türü; PowerShell 7; performans/soak.
