import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/** XSS savunmasi: cihaz adi/device_info METIN olarak basilir; ham HTML enjeksiyonu YASAK (proposal §9, M3b tasarimi). */
export function findDanger(source: string): string[] {
  return [...source.matchAll(/dangerouslySetInnerHTML|\binnerHTML\s*=|\.insertAdjacentHTML\s*\(|\bdocument\.write\s*\(/g)].map((m) => m[0]);
}

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(tsx?|jsx?)$/.test(e)) out.push(p);
  }
  return out;
}

describe("ham HTML enjeksiyonu yasagi", () => {
  it("tarayici: tehlikeli kaliplari yakalar", () => {
    expect(findDanger('<div dangerouslySetInnerHTML={{ __html: x }} />')).toEqual(["dangerouslySetInnerHTML"]);
    expect(findDanger("el.innerHTML = x")).toEqual(["innerHTML ="]);
    expect(findDanger("el.insertAdjacentHTML('beforeend', x)")).toEqual([".insertAdjacentHTML("]);
    expect(findDanger("document.write(x)")).toEqual(["document.write("]);
    expect(findDanger("<p>{name}</p>")).toEqual([]);
  });

  it("src/ altindaki HICBIR kaynak dosyada yok (bu test dosyalari haric)", () => {
    const root = resolve(__dirname, "..");
    const offenders = walk(root).filter((f) => !/[\\/]test[\\/]no-danger\.test\.ts$/.test(f)).filter((f) => findDanger(readFileSync(f, "utf8")).length > 0);
    expect(offenders).toEqual([]);
  });
});
