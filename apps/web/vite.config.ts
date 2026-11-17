import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "node:path";

/**
 * Gelistirmede /api istekleri API surecine proxy'lenir: tarayici icin AYNI KOKEN (oturum cerezi ve CSRF Origin denetimi sorunsuz).
 * API portu: API_PORT (varsayilan 8443). API tarafinda ALLOWED_ORIGINS=http://localhost:5173 verilmelidir.
 */
const apiPort = process.env.API_PORT ?? "8443";
const webPort = Number(process.env.WEB_PORT ?? 5173);

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": resolve(__dirname, "src") } },
  server: {
    port: webPort,
    strictPort: true,
    proxy: { "/api": { target: `http://127.0.0.1:${apiPort}`, changeOrigin: false, ws: false } },
  },
  preview: { port: webPort, strictPort: true, proxy: { "/api": { target: `http://127.0.0.1:${apiPort}` } } },
});
