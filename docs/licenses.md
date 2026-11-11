# Üçüncü taraf lisans kaydı

Otomatik tarama: `pnpm license-scan` (npm bağımlılıkları; GPL/AGPL/SSPL/bilinmeyen başarısız olur). NuGet bağımlılıkları için otomatik tarama henüz yok; aşağıdaki tablo elle tutulur.

## npm (tarama sonucu, 2026-11-11, 37 paket, 0 izinsiz)
MIT 29 · Apache-2.0 4 · MPL-2.0 2 (`lightningcss`, vite/vitest zincirinden dolaylı) · ISC 1 · BSD-3-Clause 1.

## NuGet (elle; paket sayfalarındaki lisans doğrulanacak — M0 sonrası görev)
| Paket | Lisans | Durum |
|---|---|---|
| Microsoft.Extensions.Hosting / .WindowsServices 10.0.14 | MIT | Ön bilgi; doğrulanmadı |
| xunit, Microsoft.NET.Test.Sdk | Apache-2.0 / MIT | Ön bilgi; doğrulanmadı |

## Dağıtılmayacak/yönlendirilecek bileşenler
PawnIO (GPL-2.0 + IOCTL istisnası) paketlenmez; `nvml.dll` yeniden dağıtılmaz; WinRing0 asla. Ayrıntı: `proposal.md` §15.
