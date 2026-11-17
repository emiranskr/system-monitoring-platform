import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeviceSummary } from "@sysmon/protocol";
import { App } from "../App";
import { SessionProvider } from "../session/SessionProvider";
import { mockFetch } from "../test/mockFetch";
import { FakeEventSource } from "./fakeEventSource";

const ID = "11111111-1111-4111-8111-111111111111";
const dev: DeviceSummary = { id: ID, name: "pc-01", status: "online", last_seen_at: new Date().toISOString(), cpu_pct: 10, mem_pct: 20, disk_used_pct: 30 };
const ME = { email: "ali@example.com", role: "admin" };

function renderApp(meStatus = 200) {
  const m = mockFetch({
    "GET /api/v1/me": () => (meStatus === 200 ? { status: 200, body: ME } : { status: 401, body: { error: "unauthorized" } }),
    "GET /api/v1/devices": () => ({ status: 200, body: { devices: [dev] } }),
  });
  const r = render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={["/cihazlar"]}><SessionProvider><App /></SessionProvider></MemoryRouter>
    </QueryClientProvider>,
  );
  return { ...m, unmount: r.unmount };
}
const devicesCalls = (m: ReturnType<typeof mockFetch>) => m.calls.filter((c) => c.url === "/api/v1/devices").length;

beforeEach(() => { FakeEventSource.reset(); vi.stubGlobal("EventSource", FakeEventSource); });
afterEach(() => vi.unstubAllGlobals());

describe("canli guncelleme (SSE) — uygulama duzeyi", () => {
  it("akis /api/v1/stream'e baglanir; olay gelince satir SAYFA YENILENMEDEN ve yeniden cekme olmadan guncellenir", async () => {
    const m = renderApp();
    const table = await screen.findByRole("table");
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    expect(FakeEventSource.last.url).toBe("/api/v1/stream");
    const before = devicesCalls(m);
    act(() => { FakeEventSource.last.emit("ready", {}); });
    act(() => { FakeEventSource.last.emit("sample", { device_id: ID, t: new Date().toISOString(), values: { "cpu.total": 77 } }); });
    expect(await within(table).findByText("%77")).toBeInTheDocument();
    expect(devicesCalls(m)).toBe(before); // yeniden cekme YOK: onbellek guncellendi
    expect(screen.queryByText(/canlı bağlantı kesildi/i)).toBeNull();
  });

  it("kopma: BANT gorunur; yeniden baglanip ready gelince bant kalkar ve veri akisi surer", async () => {
    renderApp();
    const table = await screen.findByRole("table");
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    act(() => { FakeEventSource.last.emit("ready", {}); });
    act(() => { FakeEventSource.last.emit("error"); });
    expect(await screen.findByRole("status", { name: "" })).toHaveTextContent(/canlı bağlantı kesildi/i);
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(2), { timeout: 3000 }); // geri cekilme <= 1 sn
    act(() => { FakeEventSource.last.emit("ready", {}); });
    await waitFor(() => expect(screen.queryByText(/canlı bağlantı kesildi/i)).toBeNull());
    act(() => { FakeEventSource.last.emit("sample", { device_id: ID, t: new Date().toISOString(), values: { "mem.used_pct": 88 } }); });
    expect(await within(table).findByText("%88")).toBeInTheDocument();
  });

  it("'closed' + /me 401 -> giris ekranina yonlendirir (oturum iptal edildi)", async () => {
    const m = renderApp();
    await screen.findByRole("table");
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    // oturum artik gecersiz
    mockFetch({
      "GET /api/v1/me": () => ({ status: 401, body: { error: "unauthorized" } }),
      "GET /api/v1/devices": () => ({ status: 200, body: { devices: [dev] } }),
    });
    act(() => { FakeEventSource.last.emit("closed", { reason: "session" }); });
    expect(await screen.findByRole("heading", { name: "Giriş" })).toBeInTheDocument();
    void m;
  });

  it("gecersiz/bozuk olay ekrani BOZMAZ", async () => {
    renderApp();
    const table = await screen.findByRole("table");
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    act(() => { FakeEventSource.last.emit("sample", "bozuk{json"); FakeEventSource.last.emit("sample", { device_id: "x" }); });
    expect(within(table).getByText("%10")).toBeInTheDocument();
  });

  it("bilesen kaldirilinca (cikis/oturum dusmesi) akis KAPANIR ve yeniden baglanma zamanlanmaz", async () => {
    const { unmount } = renderApp();
    await screen.findByRole("table");
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    const es = FakeEventSource.last;
    unmount();
    expect(es.closed).toBe(true);
    await new Promise((r) => setTimeout(r, 1200));
    expect(FakeEventSource.instances).toHaveLength(1);
  });
});

describe("EventSource olmayan tarayici", () => {
  it("canli akis KAPALI, bant yok, yoklamayla veri gorunur (cokmez)", async () => {
    vi.unstubAllGlobals();
    delete (globalThis as { EventSource?: unknown }).EventSource;
    renderApp();
    expect(await screen.findByRole("table")).toBeInTheDocument();
    expect(screen.queryByText(/canlı bağlantı kesildi/i)).toBeNull();
  });
});
