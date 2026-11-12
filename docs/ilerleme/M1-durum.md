# M1 Durum Raporu — 2026-11-12

**Dal:** `feat/m1-agent` (fix → batch-b → m1-agent fast-forward ile birleştirildi; tüm dallar `818fe3a`; **push yapılmadı**)
**Durum:** **M1 TAMAMLANDI — açık takip işleriyle (bölüm 3).** Kod, testler, A5, 10 dk soak ve dar kapsamlı bağımsız inceleme tamam (Critical 0, Important 0).

**Kapanış onayı:** Birleştirme ve M1 kapanışı için ayrı onay kapısı kullanıcı tarafından ChatGPT'ye devredildi ("benim değil ChatGPT'nin onayını al"). ChatGPT, bu belgedeki kanıtlar özetlenerek sorulduğunda **ONAY** verdi (2026-11-12) ve şu koşulları koydu: fast-forward sırası aynen uygulanır, push yapılmaz, ertelenen riskler ve takip işleri bu belgede açıkça listelenir, birleştirme sonrası Git durumu doğrulanır. Koşulların hepsi uygulandı. Not: bu bir insan/kullanıcı onayı değil, kullanıcının devrettiği harici bir modelin onayıdır; ChatGPT'ye kod veya log değil, bu belgenin özeti verildi.

## 1. Kanıtlar (hepsi gerçek koşu)

| Doğrulama | Sonuç | Not / kanıt |
|---|---|---|
| Debug testleri | **166/166** | Son kod |
| Release testleri | **151/151** | Son kod (Debug 166 / Release 151 farkı: `UploaderTests` yalnızca Debug) |
| A5 `Verify-ServiceInstall.ps1` (Windows, yönetici) | **BASARILI, 28 GECTI / 0 KALDI** | `kanit/a5-fix-sonrasi.log`. Servis sanal hesapla çalışıyor, PDH grup gerekliliği, ACL, token (negatif+olumlu kontrol), kurtarma, bilerek başarısız kurulumun geri alınması, yeniden kurulum, failure flag, temizlik, grup sızıntısı yok (8→8) |
| 10 dk gerçek zamanlı kesinti soak'ı (HEAD `0db33a8`) | **Geçti** (12 dk 36 sn) | 600 sn kesinti, kesintide 104 batch birikti, 661 örnek, 115 batch = 115 ham istek, **tekrar 0**, boşalma 96 sn, 10 retry, en uzun bekleme 264 sn. Test her örneği benzersiz sayaçla sayar: kayıp/çift kayıt/seq boşluğu yok. Log: `kanit/soak-10dk-fix-sonrasi.log` |
| Dar kapsamlı bağımsız inceleme (`0de529b..0db33a8`) | **Critical 0, Important 0**, Minor 6, Informational 2 | `M1-dar-inceleme-3.md`. Kod okunarak; reviewer test koşturmadı |

Önceki (eski) kanıt dosyaları değiştirilmedi: `kanit/a5-son-kod.log`, `kanit/soak-10dk-son-kod.log`.

## 2. Bağımsız inceleme 2 bulgularının durumu (`M1-bagimsiz-inceleme-2.md`)

| Bulgu | Durum | Düzeltme (commit) | Kapsayan test |
|---|---|---|---|
| I-1 çıkış kodu | **Düzeldi** | `d3635d5` (`Program.cs` `return Environment.ExitCode`) | `ProcessExitCodeTests` (gerçek süreç; kod 0 iken kırmızıydı) |
| I-2 Spool yarım yazma | **Düzeldi** | `44f98ea` (`AppendDurably`: kalıntı kırpılır; `PeekOldest` düşen ref'i sayar/bildirir) | `SpoolPartialWriteTests` (kalıntı sonrası kayıp, restart recovery, kaybolan segment sayımı) |
| I-3 kayıp görünürlüğü | **Düzeldi** | `c4c4f9e` (`LossReporter`, `onError` kablolaması, periyodik sayaç logu) | `LossReporterTests`, `HostTests.I3_...` (kablolama kaldırılınca kırmızı) |
| I-4 token / vacuous A5 | **Düzeldi** | `4687752` (`TokenProvider`, boş token istek göndermez, A5 negatif+olumlu kontrol) | `TokenProviderTests`, `UploaderEmptyTokenTests`, A5 |
| Installer M-4 (LocalSystem penceresi) | **Düzeldi (taze kurulum)** | `49ec7c9`, `0db33a8` (Disabled oluştur → yapılandır → doğrula → en son otomatik; hata halinde geri al; failureflag; https-only `-Server`; `-ServiceName` regex) | A5 aşama 4 |
| Boş testler (O7 yönlendirme, `ack<seq` Release, kesik gzip, MIN-03) | **Düzeldi** | `919c3ce` | Mutasyonla doğrulandı (aşağıda) |

**A5 sırasında bulunan ek gerçek hata:** `net localgroup` uzun servis adlarında söz dizimi hatası veriyor (varsayılan `SysMonAgent` etkilenmiyordu). `Add/Remove-LocalGroupMember` (SID ile) ile değiştirildi; üyelik, servis silinmeden önce kaldırılıyor (yetim SID yok). Kanıt: `kanit/a5-fix-sonrasi-hata-net-sozdizimi.log`, `kanit/diag-net-localgroup-uzun-ad.log`.

**Mutasyon sonuçları (gözlenen):** `AllowAutoRedirect=true` → yönlendirme testi KIRMIZI; `ack < seq` kontrolü silinince → yeni Release testi KIRMIZI; `InvalidDataException` yakalaması değişince → bozuk-içerikli gzip testi KIRMIZI. Kesik gzip varyantı bilerek yeşil kalır (.NET kesik gzip'te hata vermez); bu yüzden bozuk-içerik testi eklendi. Kablolama kaldırılınca `I3_...` testi KIRMIZI. `Program.cs` `return 0` iken `ProcessExitCodeTests` KIRMIZI.

## 3. Açık takip işleri (bilinçli ertelendi; hiçbiri Critical/Important değil)

Ayrıntı: `M1-dar-inceleme-3.md`.
- **N-1** Başarısız *yükseltmede* servis Disabled kalır ve zaten var olan grup üyeliği geri alma sırasında silinebilir; eski `ImagePath`/`StartMode` geri yüklenmez. Yeniden kurulum onarır.
- **N-2** Spool aktif segment dosyası dışarıdan (antivirüs/yönetici) silinir ya da kısalırsa `AppendDurably` dosyayı NUL ile uzatır; o batch geçersiz satıra düşer (sayılır, ama kaybolur). Düşük olasılık. **Spool veri yolu değiştiği için düzeltme 10 dk soak'ın yeniden koşulmasını gerektirir; bu yüzden şimdi yapılmadı.**
- **N-3** `PeekOldest` kaynaklı düşme için `onDropped` günlük metni "boyut veya yaş sınırı" diyor (yanlış neden).
- **N-4** A5'teki "üyelik geri alındı" kontrolü fiilen boş geçiyor (bilerek yaratılan hata üyelik eklenmeden önce çıkıyor).
- **N-6** `-Server`/dizinler `ImagePath`'e kaçışsız ekleniyor (yönetici girdisi; sertleştirme).
- **N-7** `failureflag`'in .NET Windows-service ana bilgisayarında `Environment.ExitCode` ile uçtan uca çalıştığı SCM'de kanıtlanmadı.
- **N-8** Çalışan serviste sonradan aktarılan token en geç ~5 dk sonra kullanılır (`AuthFailed` bekleme tavanı).
- Önceki rapordaki M-1…M-3, M-5…M-11 (Minor) açık.
- **Düzeltildi:** N-5 (aralıklı kırılabilen `HostTests` kilit alma penceresi) test kodunda yeniden denemeyle giderildi.

## 4. Sınırlar (dürüstlük notu)
- Gerçek ENOSPC / ani güç kesintisi otomatik test edilmedi; yarım satır kalıntısı simülasyonu ve restart recovery testleri aynı hata sınıfını kapsıyor.
- SCM'de `failureflag` fiili yeniden başlatma davranışı kanıtlanmadı (N-7).
- Bellek hedefi (private working set < 50 MB) ADR 0003'te eski kodda ölçüldü, bu HEAD'de yeniden ölçülmedi.
- Daha önce bir testin aralıklı kırıldığı bir koşu görüldü (`Expected: True / Actual: False`); sonraki 5 koşuda tekrarlanmadı, hangi test olduğu yakalanamadı. MIN-03 (bellek testinin paralel koşması) düzeltildi ve olası neden budur, ama kanıtlanmadı.
- Soak testi `HEAD 0db33a8`'de koşuldu; sonraki tek kod değişikliği test dosyası (`HostTests`) ve belgelerdir.

- **Test süresi (ortam):** Kapanış gününde son koşularda tam takım 2-4 dk sürdü (öncesinde ~25 sn). Tek yavaş test `K3_Acilista_tum_batchler...` (~183 sn; çok sayıda fsync'li yazma). Aynı test eski `Spool.cs` (`0de529b`) ile de ~3 dk 57 sn sürdü: yani gerileme kodda değil, ortamdaki disk/fsync gecikmesinde (nedeni araştırılmadı). Testler yine de geçiyor. Yavaşlık sürerse K3 testinin hacmi düşürülmeli.

## 5. Kapanış kaydı
- Birleştirme (hepsi `--ff-only`, yerel): `fix/m1-important-bulgulari` → `feat/m1-review-batch-b` → `feat/m1-agent`. Üç dal `818fe3a`'da. `main`, `feat/m0-foundations` ve `wip/m1-review-batch-b` değişmedi. Push yok.
- Açık takip işleri (bölüm 3: N-1, N-2, N-4, N-6, N-7, N-8 ve önceki Minor'lar) M1'i engellemez; M2 başında veya ayrı bir sertleştirme görevinde ele alınacak. N-2 düzeltilirse 10 dk soak yeniden koşulmalı.
- Sonraki: M2 (Backend / ingest / enrollment / DB) ve M3 (Web Dashboard).
