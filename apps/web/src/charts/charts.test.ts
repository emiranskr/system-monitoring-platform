import { describe, expect, it } from "vitest";
import type { MetricPoint } from "@sysmon/protocol";
import { labelForAdapter, pickMetrics } from "./metricMap";
import { maxPointsForWidth, RANGES, rangeToWindow, zoomRange } from "./range";
import { toUplotData } from "./toUplotData";

const pt = (sec: number, avg: number, min = avg, max = avg): MetricPoint => ({ t: new Date(1_700_000_000_000 + sec * 1000).toISOString(), avg, min, max });
const X = (sec: number) => 1_700_000_000 + sec;

describe("toUplotData: bosluk = KESINTI (interpolasyon yok)", () => {
  it("bos ve tek nokta", () => {
    expect(toUplotData([], 10)).toEqual({ x: [], avg: [], min: [], max: [] });
    expect(toUplotData([pt(0, 5, 4, 6)], 10)).toEqual({ x: [X(0)], avg: [5], min: [4], max: [6] });
  });

  it("duzenli noktalar (aralik = bucket): ara null EKLENMEZ", () => {
    const d = toUplotData([pt(0, 1), pt(10, 2), pt(20, 3)], 10);
    expect(d.x).toEqual([X(0), X(10), X(20)]);
    expect(d.avg).toEqual([1, 2, 3]);
  });

  it("aralik tam 1.5 x bucket: null EKLENMEZ; bir saniye fazlasi: null eklenir", () => {
    expect(toUplotData([pt(0, 1), pt(15, 2)], 10).avg).toEqual([1, 2]);
    const d = toUplotData([pt(0, 1), pt(16, 2)], 10);
    expect(d.avg).toEqual([1, null, 2]);
    expect(d.min).toEqual([1, null, 2]);
    expect(d.max).toEqual([1, null, 2]);
    expect(d.x).toEqual([X(0), X(10), X(16)]); // null, onceki noktadan bir bucket sonra
  });

  it("buyuk boslukta TEK null (sahte nokta yagmuru yok)", () => {
    const d = toUplotData([pt(0, 1), pt(3600, 2)], 10);
    expect(d.avg).toEqual([1, null, 2]);
  });

  it("x artan sirali kalir", () => {
    const d = toUplotData([pt(0, 1), pt(100, 2), pt(110, 3), pt(500, 4)], 10);
    expect(d.x).toEqual([...d.x].sort((a, b) => a - b));
  });
});

describe("rangeToWindow / zoomRange / maxPointsForWidth", () => {
  const now = new Date("2026-11-17T12:00:00.000Z");
  it.each([["1h", 3600], ["6h", 6 * 3600], ["24h", 86400], ["7d", 7 * 86400], ["30d", 30 * 86400]] as const)("%s penceresi %i sn", (r, sec) => {
    const w = rangeToWindow(r, now);
    expect(w.to).toBe(now.toISOString());
    expect((Date.parse(w.to) - Date.parse(w.from)) / 1000).toBe(sec);
  });
  it("30 gun API siniri (31 gun) icinde", () => {
    const w = rangeToWindow("30d", now);
    expect(Date.parse(w.to) - Date.parse(w.from)).toBeLessThanOrEqual(31 * 86400_000);
  });
  it("RANGES sirali: kisadan uzuna", () => { expect(RANGES.map((r) => r.id)).toEqual(["1h", "6h", "24h", "7d", "30d"]); });
  it("zoomRange: yakinlastir bir kisa, uzaklastir bir uzun; uclarda sabit", () => {
    expect(zoomRange("24h", "in")).toBe("6h"); expect(zoomRange("24h", "out")).toBe("7d");
    expect(zoomRange("1h", "in")).toBe("1h"); expect(zoomRange("30d", "out")).toBe("30d");
  });
  it.each([[0, 600], [NaN, 600], [5, 10], [300, 300], [800.4, 800], [5000, 1500], [510, 500], [549, 500], [1234, 1200]])("genislik %s px -> max_points %i (API araligi 10..1500)", (w, want) => {
    expect(maxPointsForWidth(w)).toBe(want);
  });
});

describe("pickMetrics: metrik adlari gercek veriden (metric-names) kesfedilir", () => {
  const names = ["cpu.total", "mem.used_pct", "disk.d.used_pct", "disk.c.used_pct", "net.eth0.rx_bps", "net.eth0.tx_bps", "net.wifi.rx_bps", "gpu.temp", "mem.total_bytes"];
  it("gruplar: cpu, mem, disk (ada gore sirali), ag (anahtara gore, rx/tx eslesir)", () => {
    const m = pickMetrics(names);
    expect(m.cpu).toBe("cpu.total");
    expect(m.mem).toBe("mem.used_pct");
    expect(m.disks).toEqual([{ letter: "c", metric: "disk.c.used_pct" }, { letter: "d", metric: "disk.d.used_pct" }]);
    expect(m.nets).toEqual([{ key: "eth0", rx: "net.eth0.rx_bps", tx: "net.eth0.tx_bps" }, { key: "wifi", rx: "net.wifi.rx_bps", tx: null }]);
  });
  it("hicbiri yoksa null/bos (GPU gibi bilinmeyenler yok sayilir; sifir cizilmez)", () => {
    expect(pickMetrics([])).toEqual({ cpu: null, mem: null, disks: [], nets: [], gpus: [] });
    expect(pickMetrics(["gpu.temp"])).toEqual({ cpu: null, mem: null, disks: [], nets: [], gpus: [] });
  });
  it("labelForAdapter: device_info.adapters ile en iyi cabayla eslesir (buyuk/kucuk harf, ozel karakterler _ olur); yoksa anahtar", () => {
    const adapters = [{ id: "{AB12-34}", name: "Ethernet" }, { id: "wifi0", name: "Wi-Fi" }];
    expect(labelForAdapter("wifi0", adapters)).toBe("Wi-Fi");
    expect(labelForAdapter("_AB12-34_", adapters)).toBe("Ethernet"); // { } -> _
    expect(labelForAdapter("bilinmeyen", adapters)).toBe("bilinmeyen");
    expect(labelForAdapter("x", [])).toBe("x");
  });
});

import { plotSeries } from "./plotSeries";
describe("plotSeries: bosluk cizgiyi KESER", () => {
  it("tum serilerde spanGaps === false (true olursa kesinti cizgiyle kapanir)", () => {
    const s = plotSeries("CPU", "#6ba6ff");
    expect(s).toHaveLength(4);
    for (const x of s.slice(1)) expect(x.spanGaps).toBe(false);
  });
});

describe("pickMetrics: GPU gruplari (gpu.<CanonicalId>.<alan>)", () => {
  it("kimlige gore gruplanir ve siralanir; olmayan alan null", () => {
    const m = pickMetrics([
      "gpu.gpu-bbb.util_pct", "gpu.gpu-aaa.util_pct", "gpu.gpu-aaa.vram_used_bytes", "gpu.gpu-aaa.vram_total_bytes", "gpu.gpu-aaa.temp_c",
      "gpu.gpu-aaa.power_w", "gpu.gpu-aaa.fan_pct", "gpu.gpu-aaa.core_clock_mhz", "gpu.gpu-aaa.mem_clock_mhz", "gpu.gpu-aaa.bilinmeyen_alan",
    ]);
    expect(m.gpus.map((g) => g.id)).toEqual(["gpu-aaa", "gpu-bbb"]);
    expect(m.gpus[0]).toEqual({
      id: "gpu-aaa", util: "gpu.gpu-aaa.util_pct", vramUsed: "gpu.gpu-aaa.vram_used_bytes", vramTotal: "gpu.gpu-aaa.vram_total_bytes", temp: "gpu.gpu-aaa.temp_c",
      power: "gpu.gpu-aaa.power_w", fan: "gpu.gpu-aaa.fan_pct", core: "gpu.gpu-aaa.core_clock_mhz", mem: "gpu.gpu-aaa.mem_clock_mhz",
    });
    expect(m.gpus[1]).toEqual({ id: "gpu-bbb", util: "gpu.gpu-bbb.util_pct", vramUsed: null, vramTotal: null, temp: null, power: null, fan: null, core: null, mem: null });
  });
  it("sensor.* ve bilinmeyen alanlar GPU grubu olusturmaz", () => {
    expect(pickMetrics(["sensor.cpu_package_temp_c", "gpu.gpu-aaa.bilinmeyen_alan"]).gpus).toEqual([]);
  });
});
