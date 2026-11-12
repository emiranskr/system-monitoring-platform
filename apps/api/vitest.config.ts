import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const src = (p: string) => fileURLToPath(new URL(p, import.meta.url));
// Calisma-alani paketleri testlerde kaynaktan cozulur (dist derlemesi gerekmez).
export default defineConfig({
  resolve: {
    alias: {
      "@sysmon/db/testing": src("../../packages/db/src/testing.ts"),
      "@sysmon/db": src("../../packages/db/src/index.ts"),
      "@sysmon/protocol": src("../../packages/protocol/src/index.ts"),
    },
  },
  test: { testTimeout: 60_000, hookTimeout: 120_000, fileParallelism: false },
});
