import { describe, expect, it } from "vitest";
import { formatBytesPerSec, formatClock, formatValue } from "./format";

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
