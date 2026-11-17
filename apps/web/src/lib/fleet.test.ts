import { describe, expect, it } from "vitest";
import type { DeviceSummary } from "@sysmon/protocol";
import { deriveFleetSummary, foldSearch, formatPct, formatRelative, STATUS_LABEL } from "./fleet";

const mk = (name: string, over: Partial<DeviceSummary> = {}): DeviceSummary => ({
  id: "11111111-1111-4111-8111-111111111111", name, status: "online",
  last_seen_at: "2026-11-17T12:00:00.000Z", cpu_pct: null, mem_pct: null, disk_used_pct: null, ...over,
});

describe("deriveFleetSummary", () => {
  it("bos filo: tum sayilar 0, listeler bos", () => {
    const s = deriveFleetSummary([]);
    expect(s.total).toBe(0);
    expect(s.counts).toEqual({ online: 0, stale: 0, offline: 0, unknown: 0, revoked: 0 });
    expect(s.topCpu).toEqual([]); expect(s.topMem).toEqual([]); expect(s.topDisk).toEqual([]);
  });

  it("durum sayilari ve toplam", () => {
    const s = deriveFleetSummary([mk("a"), mk("b", { status: "stale" }), mk("c", { status: "offline" }), mk("d", { status: "offline" }), mk("e", { status: "unknown" }), mk("f", { status: "revoked" })]);
    expect(s.counts).toEqual({ online: 1, stale: 1, offline: 2, unknown: 1, revoked: 1 });
    expect(s.total).toBe(6);
  });

  it("en yuksek CPU/bellek/disk: azalan sirali, NULL'lar listeye GIRMEZ, en cok 5, esitlikte ada gore", () => {
    const devs = Array.from({ length: 8 }, (_, i) => mk(`pc${i}`, { cpu_pct: i === 3 ? null : i * 10, mem_pct: 50, disk_used_pct: i }));
    const s = deriveFleetSummary(devs);
    expect(s.topCpu.map((d) => d.name)).toEqual(["pc7", "pc6", "pc5", "pc4", "pc2"]);
    expect(s.topMem.map((d) => d.name)).toEqual(["pc0", "pc1", "pc2", "pc3", "pc4"]); // hepsi 50: ada gore
    expect(s.topDisk).toHaveLength(5);
    expect(deriveFleetSummary([mk("x"), mk("y")]).topCpu).toEqual([]); // hepsi NULL
  });

  it("iptal edilmis cihaz en-yuksek listelerinde yer almaz", () => {
    const s = deriveFleetSummary([mk("a", { cpu_pct: 99, status: "revoked" }), mk("b", { cpu_pct: 10 })]);
    expect(s.topCpu.map((d) => d.name)).toEqual(["b"]);
  });
});

describe("foldSearch (Turkce i/I/ı/İ eslenik, buyuk/kucuk harf duyarsiz)", () => {
  it.each([["ISIK", "isik"], ["Işık", "işik"], ["İŞİK", "işik"], ["ısık", "isik"], ["PC-01", "pc-01"], ["", ""]])("%s -> %s", (a, want) => expect(foldSearch(a)).toBe(want));
  it("'isik' araması ISIK/Işık/ısık adlarını bulur", () => {
    for (const name of ["ISIK-pc", "ısık-pc", "ISIK"]) expect(foldSearch(name).includes(foldSearch("isik"))).toBe(true);
  });
});

describe("formatPct / formatRelative", () => {
  it("formatPct: NULL -> em tire; yuvarlar; sinirlar", () => {
    expect(formatPct(null)).toBe("—");
    expect(formatPct(12.4)).toBe("%12"); expect(formatPct(12.5)).toBe("%13"); expect(formatPct(0)).toBe("%0"); expect(formatPct(100)).toBe("%100");
  });
  const now = new Date("2026-11-17T12:00:00.000Z");
  it.each([
    [null, "hiç görülmedi"], [0, "şimdi"], [4_000, "4 sn önce"], [59_000, "59 sn önce"], [60_000, "1 dk önce"], [3_599_000, "59 dk önce"],
    [3_600_000, "1 sa önce"], [86_399_000, "23 sa önce"], [86_400_000, "1 gün önce"], [10 * 86_400_000, "10 gün önce"], [-5_000, "şimdi"],
  ])("fark %s ms -> %s", (diff, want) => {
    const iso = diff === null ? null : new Date(now.getTime() - diff).toISOString();
    expect(formatRelative(iso, now)).toBe(want);
  });
  it("durum etiketleri Turkce ve tekil", () => {
    expect(STATUS_LABEL).toEqual({ online: "Çevrimiçi", stale: "Bayat", offline: "Çevrimdışı", unknown: "Bilinmiyor", revoked: "İptal edildi" });
  });
});
