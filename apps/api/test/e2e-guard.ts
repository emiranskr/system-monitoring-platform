import { existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";

/**
 * Uca-uca testlerin onkosul korumasi. Varsayilan: onkosul yoksa test ATLANIR (gelistirici makinesi).
 * SYSMON_REQUIRE_E2E=1 ise: onkosul eksik veya exe kaynaktan ESKI ise test BASARISIZ olur; sessizce yesil kalmaz.
 */
const SRC = resolve(__dirname, "../../../agent/windows/src");

function newestSourceMs(dir: string): number {
  let newest = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "bin" || e.name === "obj") continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) newest = Math.max(newest, newestSourceMs(p));
    else if (e.name.endsWith(".cs") || e.name.endsWith(".csproj")) newest = Math.max(newest, statSync(p).mtimeMs);
  }
  return newest;
}

export const requireE2E = () => process.env.SYSMON_REQUIRE_E2E === "1";

/** Calistirilabilir mi? Zorunluysa ve degilse, nedenini bildiren BASARISIZ bir test kaydeder. */
export function e2eEnabled(label: string, exe: string, extra: Array<{ name: string; ok: boolean }> = []): boolean {
  const problems: string[] = [];
  if (process.platform !== "win32") problems.push("Windows degil");
  if (!existsSync(exe)) problems.push(`exe yok: ${exe}`);
  else if (requireE2E() && statSync(exe).mtimeMs < newestSourceMs(SRC)) problems.push(`exe kaynaktan eski, yeniden derleyin: ${exe}`);
  for (const x of extra) if (!x.ok) problems.push(`onkosul yok: ${x.name}`);
  if (problems.length === 0) return true;
  if (requireE2E()) {
    it(`${label}: SYSMON_REQUIRE_E2E=1 ama onkosul saglanmadi`, () => {
      expect(problems, problems.join("; ")).toEqual([]);
    });
  }
  return false;
}
