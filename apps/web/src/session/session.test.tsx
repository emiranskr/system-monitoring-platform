import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, renderHook, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LoginPage } from "../pages/LoginPage";
import { RequireAuth } from "./RequireAuth";
import { SessionProvider, useSession } from "./SessionProvider";
import { safeNext } from "./safeNext";
import { useKeepAlive } from "./useKeepAlive";
import { mockFetch } from "../test/mockFetch";

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

const ME = { email: "ali@example.com", role: "admin" };
const wrap = (initial: string, ui: ReactNode, qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })) =>
  render(<QueryClientProvider client={qc}><MemoryRouter initialEntries={[initial]}><SessionProvider>{ui}</SessionProvider></MemoryRouter></QueryClientProvider>);

function Where() { const l = useLocation(); return <output data-testid="where">{l.pathname + l.search}</output>; }
const app = (
  <>
    <Where />
    <Routes>
      <Route path="/giris" element={<LoginPage />} />
      <Route path="/cihazlar" element={<RequireAuth><h1>Cihazlar</h1></RequireAuth>} />
      <Route path="/" element={<RequireAuth><h1>Genel</h1></RequireAuth>} />
    </Routes>
  </>
);

describe("safeNext (acik yonlendirme yok)", () => {
  it.each([
    ["/cihazlar", "/cihazlar"], ["/cihazlar?x=1&y=2", "/cihazlar?x=1&y=2"], ["/cihaz/abc#t", "/cihaz/abc#t"], ["/", "/"],
    ["https://kotu.example", "/"], ["//kotu.example", "/"], ["/\\kotu.example", "/"], ["javascript:alert(1)", "/"], ["", "/"], [null, "/"],
    ["cihazlar", "/"], ["/giris?next=/x", "/"], ["/%2f%2fkotu", "/"], ["/\t/kotu", "/"],
  ])("%s -> %s", (raw, want) => expect(safeNext(raw as string | null)).toBe(want));
});

describe("oturum", () => {
  it("anonim kullanici korumali sayfada /giris?next=... adresine yonlendirilir", async () => {
    mockFetch({ "GET /api/v1/me": () => ({ status: 401, body: { error: "unauthorized" } }) });
    wrap("/cihazlar", app);
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent("/giris?next=%2Fcihazlar"));
    expect(screen.getByRole("heading", { name: /giriş/i })).toBeInTheDocument();
  });

  it("oturumlu kullanici korumali sayfayi gorur", async () => {
    mockFetch({ "GET /api/v1/me": () => ({ status: 200, body: ME }) });
    wrap("/cihazlar", app);
    expect(await screen.findByRole("heading", { name: "Cihazlar" })).toBeInTheDocument();
  });

  it("giris: dogru bilgi -> next'e doner; DIS next yok sayilir (/'a gider)", async () => {
    let authed = false;
    mockFetch({
      "GET /api/v1/me": () => (authed ? { status: 200, body: ME } : { status: 401, body: { error: "unauthorized" } }),
      "POST /api/v1/login": () => { authed = true; return { status: 200, body: { user: ME } }; },
    });
    const user = userEvent.setup();
    wrap("/giris?next=%2Fcihazlar", app);
    await user.type(await screen.findByLabelText("E-posta"), "ali@example.com");
    await user.type(screen.getByLabelText("Parola"), "dogru-parola-123");
    await user.click(screen.getByRole("button", { name: "Giriş yap" }));
    expect(await screen.findByRole("heading", { name: "Cihazlar" })).toBeInTheDocument();
  });

  it("dis next ('https://kotu.example') kabul edilmez: girisden sonra /'a gider", async () => {
    let authed = false;
    mockFetch({
      "GET /api/v1/me": () => (authed ? { status: 200, body: ME } : { status: 401, body: { error: "unauthorized" } }),
      "POST /api/v1/login": () => { authed = true; return { status: 200, body: { user: ME } }; },
    });
    const user = userEvent.setup();
    wrap("/giris?next=https%3A%2F%2Fkotu.example", app);
    await user.type(await screen.findByLabelText("E-posta"), "ali@example.com");
    await user.type(screen.getByLabelText("Parola"), "dogru-parola-123");
    await user.click(screen.getByRole("button", { name: "Giriş yap" }));
    expect(await screen.findByRole("heading", { name: "Genel" })).toBeInTheDocument();
    expect(screen.getByTestId("where")).toHaveTextContent(/^\/$/);
  });

  it.each([
    [401, { error: "invalid_credentials" }, /e-posta veya parola hatalı/i],
    [429, { error: "rate_limited" }, /çok fazla deneme/i],
  ])("giris hatasi %i -> role=alert, ayri Turkce mesaj, odak alanlarda kalir", async (status, body, msg) => {
    mockFetch({ "GET /api/v1/me": () => ({ status: 401, body: { error: "unauthorized" } }), "POST /api/v1/login": () => ({ status, body }) });
    const user = userEvent.setup();
    wrap("/giris", app);
    await user.type(await screen.findByLabelText("E-posta"), "ali@example.com");
    await user.type(screen.getByLabelText("Parola"), "yanlis-parola");
    await user.click(screen.getByRole("button", { name: "Giriş yap" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(msg);
    expect(screen.getByLabelText("Parola")).toHaveAttribute("autocomplete", "current-password");
  });

  it("ag hatasi: 'sunucuya ulasilamiyor' mesaji (kimlik hatasi DEGIL)", async () => {
    mockFetch({ "GET /api/v1/me": () => ({ status: 401, body: { error: "unauthorized" } }) });
    const user = userEvent.setup();
    wrap("/giris", app);
    await user.type(await screen.findByLabelText("E-posta"), "ali@example.com");
    await user.type(screen.getByLabelText("Parola"), "x");
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));
    await user.click(screen.getByRole("button", { name: "Giriş yap" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/sunucuya ulaşılamıyor/i);
  });

  it("cikis: POST /logout, onbellek temizlenir, anonim olur", async () => {
    let authed = true;
    const { calls } = mockFetch({
      "GET /api/v1/me": () => (authed ? { status: 200, body: ME } : { status: 401, body: { error: "unauthorized" } }),
      "POST /api/v1/logout": () => { authed = false; return { status: 204 }; },
    });
    const qc = new QueryClient();
    qc.setQueryData(["devices"], { devices: [] });
    function LogoutBtn() { const s = useSession(); return <button onClick={() => void s.logout()}>Çıkış</button>; }
    const user = userEvent.setup();
    wrap("/cihazlar", <>{app}<LogoutBtn /></>, qc);
    await screen.findByRole("heading", { name: "Cihazlar" });
    await user.click(screen.getByRole("button", { name: "Çıkış" }));
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent("/giris"));
    expect(calls.some((c) => c.method === "POST" && c.url === "/api/v1/logout")).toBe(true);
    expect(qc.getQueryData(["devices"])).toBeUndefined();
  });

  it("SOZLESME ihlali: hata ekrani gosterilir, 'undefined' render edilmez", async () => {
    mockFetch({ "GET /api/v1/me": () => ({ status: 200, body: { email: 1 } }) });
    wrap("/cihazlar", app);
    expect(await screen.findByRole("alert")).toHaveTextContent(/beklenmeyen yanıt/i);
    expect(document.body.textContent).not.toContain("undefined");
  });
});

describe("useKeepAlive (30 dk bosta kurali: 5 dk'da bir /me, yalniz gorunur sekmede)", () => {
  const setVisibility = (v: "visible" | "hidden") => Object.defineProperty(document, "visibilityState", { value: v, configurable: true });
  beforeEach(() => { vi.useFakeTimers(); setVisibility("visible"); });
  afterEach(() => setVisibility("visible"));

  it("gorunurken 5 dakikada bir cagirir", async () => {
    const { calls } = mockFetch({ "GET /api/v1/me": () => ({ status: 200, body: ME }) });
    renderHook(() => useKeepAlive(() => {}));
    await act(async () => { await vi.advanceTimersByTimeAsync(5 * 60_000 * 3 + 1000); });
    expect(calls.length).toBe(3);
  });

  it("sekme GIZLIYKEN cagirmaz", async () => {
    setVisibility("hidden");
    const { calls } = mockFetch({ "GET /api/v1/me": () => ({ status: 200, body: ME }) });
    renderHook(() => useKeepAlive(() => {}));
    await act(async () => { await vi.advanceTimersByTimeAsync(5 * 60_000 * 3); });
    expect(calls.length).toBe(0);
  });

  it("401 gelirse oturum dusurulur (onExpired cagrilir) ve zamanlayici durur", async () => {
    const { calls } = mockFetch({ "GET /api/v1/me": () => ({ status: 401, body: { error: "unauthorized" } }) });
    const onExpired = vi.fn();
    renderHook(() => useKeepAlive(onExpired));
    await act(async () => { await vi.advanceTimersByTimeAsync(5 * 60_000 * 3); });
    expect(onExpired).toHaveBeenCalledTimes(1);
    expect(calls.length).toBe(1);
  });

  it("unmount zamanlayiciyi temizler", async () => {
    const { calls } = mockFetch({ "GET /api/v1/me": () => ({ status: 200, body: ME }) });
    const { unmount } = renderHook(() => useKeepAlive(() => {}));
    unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(5 * 60_000 * 3); });
    expect(calls.length).toBe(0);
  });
});
