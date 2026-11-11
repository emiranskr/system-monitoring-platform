# ADR 0004 — Servis hesabı, PDH izni ve günlükleme (M1 A5, gerçek Windows doğrulaması)

Tarih: 2026-11-11 · Durum: Kabul edildi · Kanıt: `agent/windows/installer/Verify-ServiceInstall.ps1` çıktısı (UAC ile yükseltilmiş, gerçek Windows 11 26300, Türkçe yerel ayar)

## Kararlar
1. **Servis hesabı:** parola gerektirmeyen sanal hesap `NT SERVICE\SysMonAgent` (LocalSystem değil). Gerçek koşuda `Win32_Service.StartName` ve süreç kullanıcısı bu hesap çıktı.
2. **Program dizini** (`Program Files\SysMon\Agent`): Windows varsayılan ACL'i; servis hesabı yazamaz (Users yalnız okur/çalıştırır). **Veri dizini** (`ProgramData\SysMon\agent`): miras kapalı; SYSTEM + Administrators tam, servis hesabı Modify; Users/Everyone yok.
3. **PDH izni — ölçülmüş sonuç:** `Performance Monitor Users` üyeliği **olmadan** servis hesabı `PdhAddEnglishCounter` çağrısında `0xC0000BC8` alır (CPU sayacı eklenemez). Üyelikle `cpu.total` doluyor. **Karar:** kurulum betiği üyeliği varsayılan olarak ekler (`-SkipPerfMonUsers` ile atlanır). Grup adı yerelleşmeye bağlı olduğundan SID `S-1-5-32-558` üzerinden çözülür (Türkçe Windows'ta ad farklıdır).
4. **Bozulmuş mod:** başlangıçta bir collector kurulamıyorsa (ör. izin yok) servis ÇÖKMEZ; `cpu` collector'ı hata durumu raporlar, diğer metrikler akar, uyarı `agent.log`'a bir kez yazılır, PDH başlatması 60 sn'de bir yeniden denenir. (İlk gerçek koşuda kurucu istisnası tüm servisi düşürmüştü; düzeltme testlidir.)
5. **Günlükleme:** Windows Olay Günlüğü sağlayıcısı kaldırıldı. Düşük yetkili hesap olay kaynağı oluşturamaz ("Unable to log .NET application events" olayı gerçek koşuda görüldü) ve hata görünmez kalıyordu. Yerine `ProgramData\SysMon\agent\logs\agent.log` (Information+, 5 MB'ta tek yedekli dönüş, günlük hatası uygulamayı düşürmez). Windows Olay Günlüğü'ne yazım ileride, kurulumda kaynak kaydedilerek eklenebilir (kapsam dışı).
6. **Kurtarma:** `sc failure` ile 5 sn / 15 sn / 60 sn'de yeniden başlat; süreç öldürülünce servisin yeniden başladığı gerçek koşuda doğrulandı.
7. **Token deposu ACL'i:** SYSTEM + Administrators tam; `--token-reader` ile verilen servis hesabı Modify (okuma + rotasyonda değiştirme). Ek hesap verildiğinde kurulumu yapan yöneticinin kişisel hesabı ACL'e yazılmaz. **Sonuç:** `--import-token` yükseltilmiş (yönetici) çalıştırılmalıdır; yükseltilmemiş yönetici hesabı dosyayı sonradan okuyamaz (token servis içindir).

## Gerçek koşu özeti (4. koşu, tüm kontroller GEÇTİ)
Servis Running; hesap `NT SERVICE\SysMonAgentVerify`; grupsuz CPU yok ama servis çalışıyor ve günlükte uyarı var; bellek/disk dolu; program dizininde servis hesabına yazma kuralı yok; veri dizininde Users/Everyone yok; RESTART kurtarma tanımlı ve süreç öldürülünce yeniden başladı; grupla `cpu.total` dolu; import başarılı, düz dosya silindi, `token.bin` düz metin içermiyor; servis hesabı token'ı okuyup yükleme döngüsünü başlattı (sunucu yokken artan geri çekilmeyle `Yukleme basarisiz` uyarıları); temizlik tamam (servis ve dizinler silindi).

## Süreçte yakalanan hatalar (gerçek koşu olmadan görünmezdi)
- Kurucu istisnası servisi düşürüyordu (4. karar).
- `sc.exe config binPath=` PowerShell 5.1'de tırnakları bozup mevcut servisin komut satırını sessizce eski bırakıyordu → doğrudan `ImagePath` yazılıyor.
- "Token okunuyor" doğrulaması sunucu verilmediği için boş yere geçiyordu → günlükteki `Yukleme etkin ... token okundu` satırına bağlandı.

## Sınırlar / doğrulanmamış
Tek makine, Windows 11 26300; Windows Server ve standart (yönetici olmayan) yerel hesapla çalıştırma denenmedi; Inno Setup paketi içinden betik çağrısı (M6); LocalSystem ile karşılaştırmalı ölçüm yapılmadı; servis modunda uzun süreli ayak izi ölçülmedi.
