import { describe, expect, it } from "vitest";
import { formatBytes, formatBytesPerSec, formatClock, formatValue } from "./format";

describe("formatBytesPerSec (agent net.*.rx_bps/tx_bps BAYT/sn gonderir; ad 'bps' yaniltici)", () => {
  it.each([[0, "0 B/s"], [512, "512 B/s"], [1023, "1023 B/s"], [1024, "1.0 KB/s"], [1536, "1.5 KB/s"], [1024 * 1024, "1.0 MB/s"], [5.5 * 1024 * 1024, "5.5 MB/s"], [1024 ** 3, "1.0 GB/s"], [2 * 1024 ** 4, "2048.0 GB/s"]])("%s -> %s", (v, want) => {
    expect(formatBytesPerSec(v)).toBe(want);
  });
  it("negatif/NaN guvenli", () => { expect(formatBytesPerSec(-5)).toBe("0 B/s"); expect(formatBytesPerSec(NaN)).toBe("—"); });
});

describe("formatValue / formatClock", () => {
  it("yuzde ve bayt/sn birimleri", () => {
    expect(formatValue("pct", 12.4)).toBe("%12");
    expect(formatValue("bytes_per_sec", 2048)).toBe("2.0 KB/s");
  });
  it("saat bicimi 24 sa, tr", () => {
    expect(formatClock(Date.UTC(2026, 10, 17, 9, 5, 7), "UTC")).toMatch(/^\d{2}:\d{2}:\d{2}$/);
  });
});

describe("M4 birimleri: bytes, celsius, watt, mhz", () => {
  it.each([[0, "0 B"], [1023, "1023 B"], [1024, "1.0 KB"], [1536, "1.5 KB"], [1048576, "1.0 MB"], [12227 * 1048576, "11.9 GB"]])("formatBytes(%s) -> %s", (v, want) => {
    expect(formatBytes(v)).toBe(want);
  });
  it("formatBytes negatif/NaN guvenli", () => { expect(formatBytes(-1)).toBe("0 B"); expect(formatBytes(NaN)).toBe("—"); });
  it("formatValue yeni birimler", () => {
    expect(formatValue("bytes", 1536)).toBe("1.5 KB");
    expect(formatValue("celsius", 55.4)).toBe("55 °C");
    expect(formatValue("watt", 90.56)).toBe("90.6 W");
    expect(formatValue("mhz", 1800.4)).toBe("1800 MHz");
    expect(formatValue("pct", 40.2)).toBe("%40");
  });
});
