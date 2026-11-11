# ADR 0001 — Başlangıç kararları ve doğrulamalar

Tarih: 2026-11-11 · Durum: Kabul edildi (kullanıcının otonom geliştirme talimatıyla)

## Kararlar
| ID | Karar | Not |
|---|---|---|
| D1 | .NET 10 LTS | Aşağıdaki doğrulamaya bakın |
| D2 | TypeScript + Fastify | |
| D3 | Benchmark bütçeleri (`proposal.md` §8.3) | Kullanıcı bütçeleri gördü ve otonom geliştirme talimatı verdi; bütçeler **fiilen kabul** sayıldı. İtiraz hakkı saklı; değişiklik yalnızca M2 benchmark koşusundan ÖNCE yapılabilir. |
| D4 | Yönetici gerektiren sürücü/yardımcı isteğe bağlı | |
| D5 | MVP: TLS bearer token + rotation; batch sırası, idempotency, replay zorunlu | |
| D6 | Kod imzalama şimdilik yok | Genel dağıtım öncesi yeniden değerlendirilecek |
| D7 | Ham 3 gün, 1 dk 30 gün | |
| D8 | Inno Setup | |
| D9 | Açık kaynak | |
| D9b | **Apache-2.0** | Ruling: öneri olarak seçildi (patent hibesi, MPL-2.0 LHM ile uyumlu). Kullanıcı değiştirmek isterse yalnızca `LICENSE` ve başlık değişir. |
| D10 | Python kurulmaz; UI UX Pro Max aramaları yapılamaz | UI tasarımı doğrulanmamış taslak |
| D11 | Tek organizasyon, RLS ertelendi | |

## Doğrulama 1 — .NET 10 destek durumu (M0-1)
Kaynak: [Microsoft .NET destek politikası](https://dotnet.microsoft.com/en-us/platform/support/policy/dotnet-core), **doğrudan okundu 2026-11-11**.
.NET 10: LTS, ilk sürüm 2025-11-11, en yeni yama 10.0.15 (2026-11-10), destek sonu **2028-11-14**. .NET 8 ve 9: destek sonu 2026-11-10. SDK `global.json` ile 10.0.403'e sabitlendi.

## Doğrulama 2 — Inno Setup lisansı (M0-5)
Kaynak: [Inno Setup license.txt](https://jrsoftware.org/files/is/license.txt), **doğrudan okundu 2026-11-11**.
Lisans, "herhangi bir amaç, ticari uygulamalar dahil" kullanıma izin veriyor; yeniden dağıtım telif bildirimlerinin korunması ve değiştirilmiş sürümlerin belirtilmesi koşuluna bağlı; metinde ücret geçmiyor. Önceki arama özetindeki "6.5.0'dan beri ticari kullanıcılardan satın alma ricası" ayrı bir ticari-lisans sayfasına aittir; lisans metni bunu zorunlu kılmıyor. Açık kaynak/ticari kullanım için engel yok. **Karar:** Inno Setup ilk sürümde kullanılabilir.

## Ortam notları (M0)
- Kurulu araçlar: Node v26.13.0, .NET SDK 10.0.403, git 2.56. `pnpm` kurulu değildi → `npm install -g pnpm` ile 12.18.0 kuruldu.
- **Docker ve Python kurulu DEĞİL.** `deploy/docker-compose.yml` yazıldı fakat bu makinede **çalıştırılıp doğrulanamadı**. M2 için Timescale gerekli: seçenekler `docs/ilerleme/` raporunda.
