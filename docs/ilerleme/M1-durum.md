# M1 durum raporu (KAPANMADI) — 2026-11-11

Dal `feat/m1-agent` son commit `a71815c`: Debug **115/115** geçti (iki kez). Devam eden iş `wip/m1-review-batch-b` dalında (derlenmez).

## Tamamlanan ve kanıtlanan
- **A4** DPAPI(LocalMachine)+kısıtlı ACL+atomik değiştirme token deposu, `--import-token`/`--token-reader`; yarış hatası bulundu ve düzeltildi.
- **SPKI sabitleme** ve **Release uçtan uca TLS** testleri (gerçek Kestrel).
- **Spool**: gzip mühürleme (18,2× gerçek veri oranı, ADR 0003); incelemeden sonra indeks tabanlı/tembel yükleme (K1 Ack, K3 bellek, Ö2 yarım satır, Ö3 seq uzlaştırma, Ö4 yaş sınırı), fsync.
- **A5** gerçek Windows servis doğrulaması `BASARILI` (4. koşu): sanal hesap, PDH grubu gerekli (ADR 0004), kurtarma, token ACL.
- **Gerçek zamanlı 10 dk kesinti testi** (düzeltme ÖNCESİ kod, Release): 600 sn kesinti, 106 batch birikti, 661 örnek, 117 batch, **0 kayıp, 0 çift kayıt, seq boşluksuz**, boşalma 126 sn, `Passed` (13 dk 6 sn). Düzeltme sonrası kodla yeniden koşulmadı.
- Pipeline yazma hatası dayanıklılığı, takılan collector birikmez, NaN→null, NIC anahtar benzersizliği (hepsi testli, commit'li).

## Kalan (bağımsız incelemeden; wip dalında testleri yazıldı, uygulama yok)
Uploader: saat ofseti ±366 gün sınırı ve güvenli `server_time` ayrıştırma (K2), kültür-bağımsız zaman biçimi (Ö11), zehirli batch sayacı + `BatchDropped` (Ö8); HttpClients: yönlendirme kapalı, 1 MB yanıt sınırı, bağlantı ömrü (Ö7); UploadRunner (yazıldı) + InstanceLock (yazıldı) bağlanacak; `AgentOptions` URL/pin doğrulama; Worker: Task.Yield, token geçidi kaldır, InstanceLock, DroppedBatches günlüğü; installer: `sc config obj/sidtype` çıkış kodu, DataDir sahiplik/sondaki `\`, pin/URL doğrulama (Ö9); Program `CryptographicException`; PDH Collect hatasında yeniden başlatma.
Sonra: tüm Debug+Release testleri, A5 doğrulamasını yeniden koşma, soak'ı yeniden koşma, kapanış raporu.
