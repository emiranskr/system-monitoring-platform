import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { contrastRatio } from "../lib/contrast.js";

const css = readFileSync(resolve(__dirname, "../styles/tokens.css"), "utf8");

/** `selector { --a: #fff; ... }` blogundan token -> renk haritasi. */
function theme(selector: string): Record<string, string> {
  const m = new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`).exec(css);
  expect(m, `${selector} blogu bulunamadi`).not.toBeNull();
  const out: Record<string, string> = {};
  for (const d of m![1]!.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)) out[d[1]!] = d[2]!;
  return out;
}

const REQUIRED = ["surface-0", "surface-1", "surface-2", "border", "text-primary", "text-secondary", "accent", "status-ok", "status-warn", "status-crit", "status-offline", "status-unknown"];
const SURFACES = ["surface-0", "surface-1", "surface-2"];
const TEXTS = ["text-primary", "text-secondary", "accent", "status-ok", "status-warn", "status-crit", "status-offline", "status-unknown"];

describe.each([[":root", "koyu (varsayilan)"], [".light", "acik"]])("tokenlar: %s (%s)", (selector) => {
  const t = theme(selector);

  it("semantik tokenlarin hepsi tanimli", () => {
    for (const name of REQUIRED) expect(t[name], name).toMatch(/^#[0-9a-fA-F]{6}$/);
  });

  it("her metin/durum rengi her yuzeyde WCAG AA (>= 4.5:1)", () => {
    const fails: string[] = [];
    for (const fg of TEXTS) for (const bg of SURFACES) {
      const r = contrastRatio(t[fg]!, t[bg]!);
      if (r < 4.5) fails.push(`${fg} on ${bg}: ${r.toFixed(2)}`);
    }
    expect(fails).toEqual([]);
  });

  it("sinir rengi yuzeyden ayirt edilir (>= 1.3:1, bilesen siniri icin yardimci)", () => {
    expect(contrastRatio(t["border"]!, t["surface-1"]!)).toBeGreaterThanOrEqual(1.3);
  });

  it("form kontrol siniri her yuzeyde >= 3:1 (WCAG 1.4.11 bilesen siniri)", () => {
    const fails: string[] = [];
    for (const bg of SURFACES) { const r = contrastRatio(t["border-control"] ?? "#000000", t[bg]!); if (r < 3) fails.push(`border-control on ${bg}: ${r.toFixed(2)}`); }
    expect(t["border-control"]).toBeDefined();
    expect(fails).toEqual([]);
  });

  it("durum renkleri birbirinden ayirt edilir (ayni renk iki durumda kullanilmaz)", () => {
    const vals = ["status-ok", "status-warn", "status-crit", "status-offline", "status-unknown"].map((k) => t[k]!.toLowerCase());
    expect(new Set(vals).size).toBe(vals.length);
  });
});
