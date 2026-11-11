# Sistem İzleme Platformu

Windows makinelerinin CPU, RAM, GPU, disk, ağ ve sıcaklık verilerini toplayan, kendi sunucunuzda barındırılabilir açık kaynak izleme platformu. Lisans: Apache-2.0.

> **Durum:** geliştirme aşamasında (M0 tamamlandı). Mimari ve kararlar: [docs/proposal.md](docs/proposal.md). Plan: [docs/superpowers/plans](docs/superpowers/plans/2026-11-11-system-monitoring-platform.md). İlerleme: [docs/ilerleme](docs/ilerleme/).

## Yerel geliştirme
Önkoşullar: Node ≥ 22, pnpm 12, .NET 10 SDK, (veritabanı için) bir konteyner çalışma zamanı.

```bash
pnpm install
pnpm lint && pnpm build && pnpm test      # TypeScript paketleri + betik testleri
pnpm license-scan                         # lisans taraması
dotnet test agent/windows/SysMon.Agent.sln   # agent testleri (Debug)
```

Veritabanı (Docker gerektirir; `deploy/.env.example` dosyasını `deploy/.env` olarak kopyalayın):
```bash
docker compose -f deploy/docker-compose.yml --env-file deploy/.env up db
```

**Güvenlik kuralı:** agent düz HTTP'yi yalnızca Debug derlemesinde, `--allow-insecure-loopback` ile ve yalnızca loopback adresine kullanabilir. Release derlemelerinde bu bayrak yoktur.
