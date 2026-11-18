# Agent kurulum paketi (Inno Setup) ve test kapısı

> **Durum:** `agent/windows/installer/SysMonAgent.iss` **yazıldı ama derlenmedi ve çalıştırılmadı** (bu makinede Inno Setup kurulu değil). Betik yapısı `scripts/installer-iss.test.mjs` ile **statik** olarak sınanır; gerçek kur/yükselt/kaldır ve Defender/SmartScreen testleri **yönetici (UAC) onayı gerektirir ve kullanıcı kapısındadır** (aşağıdaki matris). Bu depodaki otomasyon bu işlemleri yapmaz.

## Paketin tasarımı
- Inno yalnız **sarmalayıcıdır**; servis oluşturma, düşük yetkili sanal hesap (`NT SERVICE\SysMonAgent`), ACL'ler, "önce Disabled, en son otomatik başlat" ve hata durumunda geri alma **`Install-SysMonService.ps1`** içindedir (gerçek makinede A-aşamalarında doğrulanmış betik).
- `PrivilegesRequired=admin`; sabit `AppId` (aynı kimlik = yerinde yükseltme).
- Yük gizli bir şey içermez. **Kayıt belirteci (enrollment token) kurulumda girilmez**; kurulumdan sonra ayrı adımda agent'a verilir.
- Sunucu adresi ve sertifika sabitleme sihirbazda (veya `/SERVER=`, `/PIN=` ile sessiz kurulumda) alınır; her değer **doğrulanır**: `https://`, kimlik bilgisi/boşluk/tırnak/kabuk karakteri yok, pin `sha256/<base64>`. Betik aynı kuralları ayrıca uygular.
- Kaldırmada veri dizini (`%ProgramData%\SysMon\agent`: spool, belirteç deposu) **varsayılan korunur**; yalnız etkileşimli kaldırmada açıkça "Evet" denirse silinir (sessiz kaldırma korur).
- PowerShell `-ExecutionPolicy Bypass` ile **paketle birlikte gelen** betikleri çalıştırır (betikler imzasızdır; imzalama ileri iştir).

## Derleme (kullanıcı makinesinde)
```bash
dotnet publish agent/windows/src/Agent.Service -c Release -r win-x64 --self-contained false -o artifacts/agent
"C:\Program Files (x86)\Inno Setup 6\ISCC.exe" /DSourceDir=artifacts\agent /DAppVersion=0.1.0 agent\windows\installer\SysMonAgent.iss
```
- `dotnet publish` komutu bu depoda **doğrulandı** (framework-bağımlı çıktı üretir; hedef makinede **.NET 10 Runtime** gerekir). `--self-contained true` seçeneği (çalışma zamanı gömülü) **denenmedi**.
- `ISCC` derlemesi **denenmedi**.

## Kullanıcı kapısı: kur / yükselt / kaldır + Defender/SmartScreen matrisi
Her satır temiz bir Windows 11 (tercihen VM/anlık görüntü) üzerinde, **yönetici onayıyla** çalıştırılır. Sonuçlar `docs/ilerleme/kanit/` altına not edilir.

| # | Senaryo | Beklenen | Sonuç |
|---|---|---|---|
| 1 | Temiz kurulum (sihirbaz, https sunucu) | Servis `NT SERVICE\SysMonAgent`, başlangıç Otomatik(gecikmeli), `LocalSystem` değil; veri dizini yalnız SYSTEM/Administrators/servis hesabı | |
| 2 | Sessiz kurulum `/VERYSILENT /SERVER=https://... /PIN=sha256/...` | Aynı | |
| 3 | Geçersiz `/SERVER=http://x` veya tırnaklı değer | Kurulum **başlamaz** | |
| 4 | Kurulum ortası hata (ör. hedef kilitli) | Geri alma: servis/dizin yarım kalmaz | |
| 5 | Yükseltme (aynı `AppId`, yeni sürüm) | Servis durur→dosyalar güncellenir→`ImagePath` korunur/güncellenir→veri dizini ve belirteç **korunur** | |
| 6 | Kaldırma (etkileşimli, veri "Hayır") | Servis ve program silinir; veri dizini **kalır** | |
| 7 | Kaldırma (etkileşimli, veri "Evet") ve sessiz kaldırma | "Evet": veri silinir; sessiz: veri **kalır** | |
| 8 | Kaldırma sırasında betik kendi dizinini siliyor (`{app}\installer`) | Hata olmadan tamamlanır (bilinen risk) | |
| 9 | SmartScreen (imzasız `.exe`) | Uyarı beklenir (kaçınılmaz); kayıt altına al | |
| 10 | Defender gerçek zamanlı koruma + ASR kuralları açıkken kur | Engellenmiyor mu? (proposal.md §: imzasız `.tmp` engeli bildirildi) | |
| 11 | Kurulum sonrası `Verify-ServiceInstall.ps1` | Tüm denetimler geçer | |

Bu matris **tamamlanmadan** "kurulum paketi hazır" denmez. Gerçek LibreHardwareMonitor/PawnIO, resmi 30 dk B6 koşusu ve A5 Windows servis doğrulaması da aynı kullanıcı kapısındadır.
