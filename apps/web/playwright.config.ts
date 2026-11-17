import { defineConfig } from "@playwright/test";
import { WEB_ORIGIN } from "./e2e/constants";

/**
 * GERCEK uca-uca: gecici TimescaleDB + derlenmis API sureci + Vite (global-setup baslatir). Sahte API YOK.
 * Tarayici INDIRILMEZ: makinedeki Google Chrome kullanilir (`channel: "chrome"`).
 */
const responsive = /(a11y|responsive)\.spec\.ts/;

export default defineConfig({
  testDir: "./e2e",
  globalSetup: "./e2e/global-setup.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [["list"], ["html", { open: "never" }]],
  use: { baseURL: WEB_ORIGIN, channel: "chrome", trace: "retain-on-failure", screenshot: "only-on-failure" },
  projects: [
    { name: "desktop", use: { viewport: { width: 1280, height: 800 } } },
    { name: "tablet", use: { viewport: { width: 768, height: 1024 } }, testMatch: responsive },
    { name: "mobile", use: { viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }, testMatch: responsive },
  ],
});
