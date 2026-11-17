# ADR 0004 — M4 G0 GPU spike (KISMI, yalnız mevcut makine)

Tarih: 2026-11-17. Durum: **TASLAK / kısmi**. ChatGPT kararı: G0 yalnız bu makinede, salt okunur ve yönetici gerektirmeden yapılır; eksik profiller "doğrulanmadı" diye kaydedilir (varsayımla başarılı/başarısız ilan edilmez). Üretim kodu yok. Sürücü kurma/değiştirme, HVCI değiştirme, yönetici işlemi yok.

## Profil durumu
| Profil | Durum |
|---|---|
| NVIDIA masaüstü (bu makine) | Kısmen ölçüldü (aşağıda) |
| Hibrit dizüstü | **Doğrulanmadı** (donanım yok; ileride kullanıcı destekli) |
| GPU'suz VM | **Doğrulanmadı** (VM yok; ileride kullanıcı destekli) |

## Ölçülenler (bu makine, standart kullanıcı, yönetici DEĞİL)
- **Standart hesap:** oturum yönetici değil; aşağıdaki okumaların hepsi yönetici olmadan çalıştı.
- **nvidia-smi** (salt okunur): sürücü 621.24, GeForce RTX 5070, 12227 MiB VRAM; kullanım, sıcaklık, güç (W) okunabiliyor.
- **nvml.dll:** `C:\Windows\System32\nvml.dll` sürücüyle geliyor (dosya sürümü 8.17.16.2124). NVML P/Invoke ile alan bazlı sorgu ölçümü **henüz yapılmadı** (G2'de sahte NVML + elle nvidia-smi karşılaştırması).
- **PDH:** `GPU Engine`, `GPU Adapter Memory`, `GPU Local Adapter Memory`, `GPU Non Local Adapter Memory`, `GPU Process Memory` kümeleri standart hesapla okunabiliyor. `GPU Engine` 3D için 93 örnek (süreç/motor başına) geldi; toplam kullanım örnek toplamıdır, tek adaptörü temsil etmez → LUID ile adaptöre eşleme gerekir. `GPU Adapter Memory` 3 LUID örneği verdi (NVIDIA + iki başka adaptör); NVML UUID ↔ PDH LUID eşlemesi G1/G2'de çözülecek (CanonicalId).
- **Çoklu adaptör:** sistemde AMD Radeon (iGPU) + NVIDIA birlikte; yani masaüstü de çoklu GPU. HAL, sağlayıcıların ürettiği cihazları tekilleştirmeli ve NVIDIA dışı adaptörü "kullanılamıyor/yalnız PDH" olarak ele almalı.
- **HVCI (yalnız okuma):** `Win32_DeviceGuard` → `SecurityServicesRunning = {2}` (HVCI çalışıyor), VBS durumu 2 (çalışıyor). Değiştirilmedi. **Sonuç:** üçüncü taraf çekirdek sürücüleri (PawnIO/LHM) bu makinede HVCI altında engellenebilir → G3'te "sensör kullanılamıyor" yolu birinci sınıf olmalı. Gerçek LHM davranışı **ölçülmedi** (sürücü yok/kurmuyoruz).
- **Kasa tipi:** 3 (masaüstü).

## Kararlar (mevcut kanıtla)
1. GPU kullanımı/VRAM için **NVML birincil**, PDH ikincil (NVIDIA dışı adaptörler ve NVML yokluğu için yedek).
2. NVML yokluğu/`NOT_SUPPORTED` zarifçe "kullanılamıyor"a düşer (G2 testleri).
3. Sıcaklık/sensör (SMBus, LHM) **M4'te yalnız ISensorProvider + SensorHelper protokolü + sahte sağlayıcı**; gerçek LHM entegrasyonu ayrı, kullanıcı onaylı kapı (HVCI açık olduğu için engellenme olasılığı yüksek).
4. PawnIO paketlenmez.

## Bilinmeyenler / açık
- Hibrit dizüstüde NVML'nin dGPU'yu uyanık tutması ve güç tüketimi: **doğrulanmadı**.
- GPU'suz VM'de PDH/NVML davranışı: **doğrulanmadı** (beklenti: NVML yok → zarif düşüş; testle sahte sağlayıcıyla kapsanır).
- Hangi LHM sürümü hangi sürücüyü kullanıyor, SMBus/mutex çakışması: **ölçülmedi**.
- PDH LUID ↔ NVML UUID eşlemesi, WDDM'de süreç başına sorgu sınırı: G1/G2'de.
