import { fileURLToPath } from "node:url";

/** E2E sabitleri. Parolalar YALNIZ bu testin gecici veritabani icin uretilmis TEST degerleridir (gercek hesaba ait degil). */
export const WEB_PORT = Number(process.env.E2E_WEB_PORT ?? 5199);
export const API_PORT = Number(process.env.E2E_API_PORT ?? 18599);
export const WEB_ORIGIN = `http://localhost:${WEB_PORT}`;
export const API_ORIGIN = `http://127.0.0.1:${API_PORT}`;

export const E2E_PASSWORD = "e2e-test-parola-12345";
export const USERS = {
  owner: "owner@example.com",
  admin: "admin@example.com",
  viewer: "viewer@example.com",
  orgB: "b-owner@example.com",
  /** Oturumu testte VERITABANINDAN silinen kullanici (ortak storageState oturumlarini etkilemesin). */
  revoke: "revoke@example.com",
} as const;

/** Playwright storageState dosyasi (global-setup bir kez giris yapip yazar; testler tekrar giris yapmaz: hiz sinirina takilmaz). */
export const authFile = (u: "owner" | "admin" | "viewer") => fileURLToPath(new URL(`./.auth/${u}.json`, import.meta.url));

/** Veri tohumu: cihaz adlari (testler bunlara gore dogrular). */
export const DEVICES = {
  online: "pc-online",
  gap: "pc-bosluk",
  offline: "pc-cevrimdisi",
  never: "pc-hic-gorulmedi",
  revoked: "pc-iptal",
  evil: "<img src=x onerror=alert(1)>pc-xss",
  orgB: "pc-b-gizli",
} as const;

export const STATE_FILE = new URL("./.state.json", import.meta.url);

export interface E2EState {
  dbUrl: string;
  orgId: string;
  orgBId: string;
  devices: Record<keyof typeof DEVICES, { id: string; token: string }>;
}
