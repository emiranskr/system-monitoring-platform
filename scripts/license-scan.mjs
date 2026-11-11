// pnpm bagimliliklarinin lisanslarini tarar; izinsiz lisansta cikis kodu 1 doner.
import { execSync } from "node:child_process";
import { isAllowed } from "./license-policy.mjs";

const raw = execSync("pnpm licenses list --json", { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
const byLicense = JSON.parse(raw);
let bad = 0;
let total = 0;
for (const [license, pkgs] of Object.entries(byLicense)) {
  total += pkgs.length;
  if (!isAllowed(license)) {
    bad += pkgs.length;
    for (const p of pkgs) console.error(`IZINSIZ: ${p.name}@${p.versions?.join(",")} -> ${license}`);
  }
}
console.log(`${total} paket tarandi, ${bad} izinsiz.`);
process.exit(bad ? 1 : 0);
