// docs/api/openapi.json dosyasini panel API zod semalarindan uretir. On kosul: pnpm --filter @sysmon/protocol build
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildOpenApi } from "../dist/index.js";

const out = resolve(dirname(fileURLToPath(import.meta.url)), "../../../docs/api/openapi.json");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(buildOpenApi(), null, 2) + "\n");
console.log("yazildi:", out);
