import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { cn } from "./lib/cn";
import { SessionProvider } from "./session/SessionProvider";
import { mockFetch } from "./test/mockFetch";

afterEach(() => vi.unstubAllGlobals());

const renderApp = (path: string) =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter initialEntries={[path]}><SessionProvider><App /></SessionProvider></MemoryRouter>
    </QueryClientProvider>,
  );

describe("uygulama", () => {
  it("oturumsuz '/' giris ekranini gosterir", async () => {
    mockFetch({ "GET /api/v1/me": () => ({ status: 401, body: { error: "unauthorized" } }) });
    renderApp("/");
    expect(await screen.findByRole("heading", { name: "Giriş" })).toBeInTheDocument();
  });

  it("oturumlu '/' ana basligi gosterir", async () => {
    mockFetch({ "GET /api/v1/me": () => ({ status: 200, body: { email: "a@example.com", role: "viewer" } }) });
    renderApp("/");
    expect(await screen.findByRole("heading", { level: 1, name: "Sistem İzleme" })).toBeInTheDocument();
  });

  it("bilinmeyen yol 'Sayfa bulunamadi'", async () => {
    mockFetch({ "GET /api/v1/me": () => ({ status: 401, body: { error: "unauthorized" } }) });
    renderApp("/yok-boyle-sayfa");
    expect(await screen.findByRole("heading", { name: "Sayfa bulunamadı" })).toBeInTheDocument();
  });

  it("cn: kosullu siniflari birlestirir, cakisan Tailwind siniflarinda sonuncu kazanir", () => {
    expect(cn("p-2", false && "hidden", "p-4")).toBe("p-4");
    expect(cn("text-text-primary", undefined, "font-semibold")).toBe("text-text-primary font-semibold");
  });
});
