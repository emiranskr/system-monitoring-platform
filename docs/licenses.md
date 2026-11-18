# Üçüncü taraf lisans kaydı

Otomatik tarama: `pnpm license-scan` (npm bağımlılıkları; GPL/AGPL/SSPL/bilinmeyen başarısız olur). NuGet bağımlılıkları için otomatik tarama henüz yok; aşağıdaki tablo elle tutulur.

## npm (tarama sonucu, 2026-11-18, 220 paket, 0 izinsiz)
MIT 88 · Apache-2.0 4 · BSD-3-Clause 4 · ISC 5 · MPL-2.0 2 (`lightningcss`, vite/vitest zincirinden dolaylı).

> **Düzeltme (2026-11-15):** önceki taramalar (37–39 paket) yalnızca KÖK projeyi tarıyordu (`pnpm licenses list`, `-r` yok); workspace paketlerinin bağımlılıkları (fastify, pg, zod, …) hiç taranmamıştı. `scripts/license-scan.mjs` artık `-r` kullanır; yeniden taramada izinsiz lisans çıkmadı. Yeni bağımlılık: `@node-rs/argon2` (MIT; platforma özgü ön derlenmiş ikili).
> **M5 (2026-11-18):** yeni bağımlılık `nodemailer` 10.6.0 (MIT-0; SMTP bildirimi). Tarama 220 paket, izinsiz yok.

## NuGet (elle; paket sayfalarındaki lisans doğrulanacak — M0 sonrası görev)
| Paket | Lisans | Durum |
|---|---|---|
| Microsoft.Extensions.Hosting / .WindowsServices 10.0.14 | MIT | Ön bilgi; doğrulanmadı |
| xunit, Microsoft.NET.Test.Sdk | Apache-2.0 / MIT | Ön bilgi; doğrulanmadı |

## Dağıtılmayacak/yönlendirilecek bileşenler
PawnIO (GPL-2.0 + IOCTL istisnası) paketlenmez; `nvml.dll` yeniden dağıtılmaz; WinRing0 asla. Ayrıntı: `proposal.md` §15.
