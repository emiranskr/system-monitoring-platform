# Üçüncü taraf lisans kaydı

Otomatik tarama: `pnpm license-scan` (npm bağımlılıkları; GPL/AGPL/SSPL/bilinmeyen başarısız olur). NuGet bağımlılıkları için otomatik tarama henüz yok; aşağıdaki tablo elle tutulur.

## npm (tarama sonucu, 2026-11-18, 220 paket, 0 izinsiz)
Sürüm bazlı 225 kayıt (`pnpm licenses list -r`; tarama betiği 220 benzersiz paket sayar): MIT 191 · Apache-2.0 11 · BSD-3-Clause 6 · ISC 6 · MPL-2.0 4 (`lightningcss` dahil, vite/vitest zincirinden dolaylı) · BSD-2-Clause 2 · BlueOak-1.0.0 2 · MIT-0 1 (`nodemailer`) · 0BSD 1 · OFL-1.1 1 (yazı tipi). İzinsiz lisans yok.

> **Düzeltme (2026-11-15):** önceki taramalar (37–39 paket) yalnızca KÖK projeyi tarıyordu (`pnpm licenses list`, `-r` yok); workspace paketlerinin bağımlılıkları (fastify, pg, zod, …) hiç taranmamıştı. `scripts/license-scan.mjs` artık `-r` kullanır; yeniden taramada izinsiz lisans çıkmadı. Yeni bağımlılık: `@node-rs/argon2` (MIT; platforma özgü ön derlenmiş ikili).
> **M5 (2026-11-18):** yeni bağımlılık `nodemailer` 10.6.0 (MIT-0; SMTP bildirimi). Tarama 220 paket, izinsiz yok.

## NuGet (elle; paket sayfalarındaki lisans doğrulanacak — M0 sonrası görev)
| Paket | Lisans | Durum |
|---|---|---|
| Microsoft.Extensions.Hosting / .WindowsServices 10.0.14 | MIT | Ön bilgi; doğrulanmadı |
| xunit, Microsoft.NET.Test.Sdk | Apache-2.0 / MIT | Ön bilgi; doğrulanmadı |

## Dağıtılmayacak/yönlendirilecek bileşenler
PawnIO (GPL-2.0 + IOCTL istisnası) paketlenmez; `nvml.dll` yeniden dağıtılmaz; WinRing0 asla. Ayrıntı: `proposal.md` §15.
