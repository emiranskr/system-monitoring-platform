import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeviceSummary } from "@sysmon/protocol";
import { DevicesPage } from "../pages/DevicesPage";
import { RequireAuth } from "../session/RequireAuth";
import { SessionProvider } from "../session/SessionProvider";
import { mockFetch, type MockCall } from "../test/mockFetch";

const TOKEN = "T".repeat(43);
const dev: DeviceSummary = { id: "11111111-1111-4111-8111-111111111111", name: "pc-01", status: "online", last_seen_at: new Date().toISOString(), cpu_pct: 1, mem_pct: 2, disk_used_pct: 3 };

interface Opts { role?: "owner" | "admin" | "viewer"; create?: (c: MockCall) => { status: number; body?: unknown } }
function renderPage(opts: Opts = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const m = mockFetch({
    "GET /api/v1/me": () => ({ status: 200, body: { email: "ali@example.com", role: opts.role ?? "admin" } }),
    "GET /api/v1/devices": () => ({ status: 200, body: { devices: [dev] } }),
    "POST /api/v1/enrollment-tokens": opts.create ?? (() => ({ status: 201, body: { token: TOKEN, expires_at: new Date(Date.now() + 3600_000).toISOString() } })),
  });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={["/cihazlar"]}>
        <SessionProvider>
          <Routes>
            <Route path="/giris" element={<h1>Giriş</h1>} />
            <Route path="/cihazlar" element={<RequireAuth><DevicesPage /></RequireAuth>} />
          </Routes>
        </SessionProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { qc, ...m };
}

const clipboard = { writeText: vi.fn(async () => {}) };
beforeEach(() => { clipboard.writeText = vi.fn(async () => {}); Object.defineProperty(navigator, "clipboard", { value: clipboard, configurable: true }); });
afterEach(() => vi.unstubAllGlobals());

const openDialog = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(await screen.findByRole("button", { name: "Cihaz ekle" }));
  return screen.findByRole("dialog", { name: /cihaz ekle/i });
};

describe("Cihaz ekle (enrollment token)", () => {
  it("viewer icin dugme YOK; admin ve owner icin var", async () => {
    renderPage({ role: "viewer" });
    await screen.findByRole("table");
    expect(screen.queryByRole("button", { name: "Cihaz ekle" })).toBeNull();
  });

  it.each(["admin", "owner"] as const)("%s: dugme gorunur", async (role) => {
    renderPage({ role });
    expect(await screen.findByRole("button", { name: "Cihaz ekle" })).toBeInTheDocument();
  });

  it("varsayilan 60 dk: POST govdesi {ttl_minutes:60}; token YALNIZ simdi, tek kullanimlik uyarisiyla gosterilir", async () => {
    const user = userEvent.setup();
    const { calls } = renderPage();
    const dlg = await openDialog(user);
    await user.click(within(dlg).getByRole("button", { name: "Token oluştur" }));
    expect(await within(dlg).findByText(TOKEN)).toBeInTheDocument();
    expect(calls.find((c) => c.method === "POST")!.body).toEqual({ ttl_minutes: 60 });
    expect(within(dlg).getByText(/yalnızca şimdi görüntülenir/i)).toBeInTheDocument();
  });

  it("Kopyala: panoya yazar ve 'Kopyalandi' bildirir; pano reddederse yedek mesaj", async () => {
    const user = userEvent.setup();
    // userEvent.setup() kendi pano taslagini kurar: testin panosu kurulumdan SONRA tanimlanir.
    Object.defineProperty(navigator, "clipboard", { value: clipboard, configurable: true });
    renderPage();
    const dlg = await openDialog(user);
    await user.click(within(dlg).getByRole("button", { name: "Token oluştur" }));
    await within(dlg).findByText(TOKEN);
    await user.click(within(dlg).getByRole("button", { name: "Kopyala" }));
    expect(clipboard.writeText).toHaveBeenCalledWith(TOKEN);
    expect(await within(dlg).findByText("Kopyalandı")).toBeInTheDocument();

    clipboard.writeText = vi.fn(async () => { throw new Error("izin yok"); });
    await user.click(within(dlg).getByRole("button", { name: "Kopyala" }));
    expect(await within(dlg).findByText(/kopyalanamadı/i)).toBeInTheDocument();
  });

  it.each([[4, false], [5, true], [1440, true], [1441, false], [0, false]])("TTL %i dk -> istek %s", async (ttl, sent) => {
    const user = userEvent.setup();
    const { calls } = renderPage();
    const dlg = await openDialog(user);
    const input = within(dlg).getByLabelText(/geçerlilik/i);
    await user.clear(input);
    await user.type(input, String(ttl));
    await user.click(within(dlg).getByRole("button", { name: "Token oluştur" }));
    if (sent) { await within(dlg).findByText(TOKEN); expect(calls.find((c) => c.method === "POST")!.body).toEqual({ ttl_minutes: ttl }); }
    else { expect(await within(dlg).findByRole("alert")).toHaveTextContent(/5 ile 1440/); expect(calls.some((c) => c.method === "POST")).toBe(false); }
  });

  it("diyalog kapaninca token DOM'dan ve mutasyon onbelleginden SILINIR; yeniden acilinca yok", async () => {
    const user = userEvent.setup();
    const { qc } = renderPage();
    const dlg = await openDialog(user);
    await user.click(within(dlg).getByRole("button", { name: "Token oluştur" }));
    await within(dlg).findByText(TOKEN);
    await user.keyboard("{Escape}"); // Esc ile kapanir
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.body.textContent).not.toContain(TOKEN);
    await waitFor(() => expect(JSON.stringify(qc.getMutationCache().getAll().map((m) => m.state.data))).not.toContain(TOKEN));
    const again = await openDialog(user);
    expect(within(again).queryByText(TOKEN)).toBeNull();
    expect(within(again).getByRole("button", { name: "Token oluştur" })).toBeInTheDocument();
  });

  it.each([
    [403, { error: "forbidden" }, /yetkiniz yok/i],
    [429, { error: "rate_limited" }, /çok fazla istek/i],
  ])("hata %i -> role=alert Turkce mesaj; token gosterilmez", async (status, body, msg) => {
    const user = userEvent.setup();
    renderPage({ create: () => ({ status, body }) });
    const dlg = await openDialog(user);
    await user.click(within(dlg).getByRole("button", { name: "Token oluştur" }));
    expect(await within(dlg).findByRole("alert")).toHaveTextContent(msg);
    expect(within(dlg).queryByText(TOKEN)).toBeNull();
  });

  it("401 (oturum dustu) -> giris ekranina yonlendirir", async () => {
    const user = userEvent.setup();
    renderPage({ create: () => ({ status: 401, body: { error: "unauthorized" } }) });
    const dlg = await openDialog(user);
    await user.click(within(dlg).getByRole("button", { name: "Token oluştur" }));
    expect(await screen.findByRole("heading", { name: "Giriş" })).toBeInTheDocument();
  });
});
