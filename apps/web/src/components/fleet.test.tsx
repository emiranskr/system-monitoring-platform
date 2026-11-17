import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DeviceStatus, DeviceSummary } from "@sysmon/protocol";
import { DevicesPage } from "../pages/DevicesPage";
import { OverviewPage } from "../pages/OverviewPage";
import { SessionProvider } from "../session/SessionProvider";
import { RequireAuth } from "../session/RequireAuth";
import { StatusBadge } from "./StatusBadge";
import { mockFetch } from "../test/mockFetch";

afterEach(() => vi.unstubAllGlobals());

const ME = { email: "ali@example.com", role: "admin" };
const dev = (i: number, over: Partial<DeviceSummary> = {}): DeviceSummary => ({
  id: `11111111-1111-4111-8111-${String(i).padStart(12, "0")}`, name: `pc-${String(i).padStart(2, "0")}`, status: "online",
  last_seen_at: new Date().toISOString(), cpu_pct: i * 3, mem_pct: 40, disk_used_pct: 50, ...over,
});
function Where() { const l = useLocation(); return <output data-testid="where">{l.pathname + l.search}</output>; }

function renderAt(path: string, devices: DeviceSummary[] | (() => { status: number; body?: unknown })) {
  mockFetch({
    "GET /api/v1/me": () => ({ status: 200, body: ME }),
    "GET /api/v1/devices": typeof devices === "function" ? devices : () => ({ status: 200, body: { devices } }),
  });
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={[path]}>
        <SessionProvider>
          <Where />
          <Routes>
            <Route path="/giris" element={<h1>Giriş</h1>} />
            <Route path="/" element={<RequireAuth><OverviewPage /></RequireAuth>} />
            <Route path="/cihazlar" element={<RequireAuth><DevicesPage /></RequireAuth>} />
          </Routes>
        </SessionProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("StatusBadge: durum = ikon + metin + renk", () => {
  it.each<[DeviceStatus, string]>([["online", "Çevrimiçi"], ["stale", "Bayat"], ["offline", "Çevrimdışı"], ["unknown", "Bilinmiyor"], ["revoked", "İptal edildi"]])(
    "%s -> metin '%s' gorunur, ikon aria-hidden", (status, label) => {
      const { container } = render(<StatusBadge status={status} />);
      expect(screen.getByText(label)).toBeVisible();
      expect(container.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
      expect(container.firstElementChild?.className).toMatch(/status-/);
    });
});

describe("Genel bakis", () => {
  it("durum sayilari ve en yuksek CPU listesi gorunur", async () => {
    renderAt("/", [dev(1), dev(2, { status: "stale" }), dev(3, { status: "offline", cpu_pct: null }), dev(4, { cpu_pct: 99 })]);
    expect(await screen.findByRole("heading", { name: "Genel bakış" })).toBeInTheDocument();
    const counts = screen.getByRole("region", { name: "Durum özeti" });
    expect(within(counts).getByText("Çevrimiçi").closest("div")).toHaveTextContent("2");
    expect(within(counts).getByText("Bayat").closest("div")).toHaveTextContent("1");
    expect(within(counts).getByText("Çevrimdışı").closest("div")).toHaveTextContent("1");
    const top = screen.getByRole("region", { name: "En yüksek CPU" });
    expect(within(top).getAllByRole("listitem")[0]).toHaveTextContent("pc-04");
  });

  it("bos filo: 'Henuz cihaz yok'", async () => {
    renderAt("/", []);
    expect(await screen.findByText(/henüz cihaz yok/i)).toBeInTheDocument();
  });

  it("401 -> girise yonlendirir (oturum dustu)", async () => {
    renderAt("/", () => ({ status: 401, body: { error: "unauthorized" } }));
    await screen.findByRole("heading", { name: "Giriş" });
    expect(screen.getByTestId("where")).toHaveTextContent("/giris");
  });

  it("sozlesme ihlali: acik hata, 'undefined' yok", async () => {
    renderAt("/", () => ({ status: 200, body: { devices: [{ id: "x" }] } }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/beklenmeyen yanıt/i);
    expect(document.body.textContent).not.toContain("undefined");
  });
});

describe("Cihaz listesi", () => {
  const rowsOf = (table: HTMLElement) => within(table).getAllByRole("row");
  const firstCells = (table: HTMLElement) => rowsOf(table).slice(1).map((r) => within(r).getAllByRole("cell")[0]!.textContent);

  it("tum cihazlar satir olarak, NULL degerler em tire", async () => {
    renderAt("/cihazlar", [dev(1), dev(2, { cpu_pct: null, mem_pct: null, disk_used_pct: null, last_seen_at: null, status: "unknown" })]);
    const table = await screen.findByRole("table");
    const rows = rowsOf(table);
    expect(rows).toHaveLength(3); // baslik + 2
    expect(within(rows[2]!).getAllByText("—").length).toBeGreaterThanOrEqual(3);
    expect(within(rows[2]!).getByText("hiç görülmedi")).toBeInTheDocument();
  });

  it("arama: ada gore, buyuk/kucuk harf duyarsiz", async () => {
    const user = userEvent.setup();
    renderAt("/cihazlar", [dev(1, { name: "MUHASEBE-PC" }), dev(2, { name: "ISIK-pc" }), dev(3, { name: "depo" })]);
    const table = await screen.findByRole("table");
    const box = screen.getByRole("searchbox", { name: "Cihaz ara" });
    await user.type(box, "muhasebe");
    expect(rowsOf(table)).toHaveLength(2);
    expect(screen.getByText("MUHASEBE-PC")).toBeInTheDocument();
    await user.clear(box);
    await user.type(box, "isik");
    expect(screen.getByText("ISIK-pc")).toBeInTheDocument();
  });

  it("durum suzgeci: yalniz secilen durum", async () => {
    const user = userEvent.setup();
    renderAt("/cihazlar", [dev(1), dev(2, { status: "offline" }), dev(3, { status: "offline" })]);
    const table = await screen.findByRole("table");
    await user.selectOptions(screen.getByRole("combobox", { name: "Durum" }), "offline");
    expect(rowsOf(table)).toHaveLength(3);
  });

  it("siralama: baslik DUGMESI (klavye), aria-sort gunceller, ikinci tikta ters", async () => {
    const user = userEvent.setup();
    renderAt("/cihazlar", [dev(1, { cpu_pct: 10 }), dev(2, { cpu_pct: 90 }), dev(3, { cpu_pct: 50 })]);
    const table = await screen.findByRole("table");
    within(table).getByRole("button", { name: /CPU/ }).focus();
    await user.keyboard("{Enter}");
    expect(within(table).getByRole("columnheader", { name: /CPU/ })).toHaveAttribute("aria-sort", "ascending");
    expect(firstCells(table)).toEqual(["pc-01", "pc-03", "pc-02"]);
    await user.keyboard("{Enter}");
    expect(within(table).getByRole("columnheader", { name: /CPU/ })).toHaveAttribute("aria-sort", "descending");
    expect(firstCells(table)).toEqual(["pc-02", "pc-03", "pc-01"]);
  });

  it("NULL degerler siralamada her iki yonde de SONA gider", async () => {
    const user = userEvent.setup();
    renderAt("/cihazlar", [dev(1, { cpu_pct: null }), dev(2, { cpu_pct: 5 }), dev(3, { cpu_pct: 9 })]);
    const table = await screen.findByRole("table");
    const btn = within(table).getByRole("button", { name: /CPU/ });
    await user.click(btn);
    expect(firstCells(table)[2]).toBe("pc-01");
    await user.click(btn);
    expect(firstCells(table)[2]).toBe("pc-01");
  });

  it("XSS: cihaz adi METIN olarak gorunur (img/script elemani olusmaz); 300 karakterlik ad satiri tasirmaz", async () => {
    const evil = "<img src=x onerror=alert(1)><script>alert(2)</script>";
    renderAt("/cihazlar", [dev(1, { name: evil }), dev(2, { name: "u".repeat(300) })]);
    const table = await screen.findByRole("table");
    expect(table.querySelector("img")).toBeNull();
    expect(table.querySelector("script")).toBeNull();
    expect(within(table).getByText(evil)).toBeInTheDocument();
    const long = within(table).getByText("u".repeat(300));
    expect(long.className).toMatch(/truncate|break-words|break-all/);
  });

  it("500 cihaz: hepsi listelenir", async () => {
    renderAt("/cihazlar", Array.from({ length: 500 }, (_, i) => dev(i + 1)));
    const table = await screen.findByRole("table");
    expect(rowsOf(table)).toHaveLength(501);
  });

  it("filtre sonucu bos: 'Eslesen cihaz yok'", async () => {
    const user = userEvent.setup();
    renderAt("/cihazlar", [dev(1)]);
    await screen.findByRole("table");
    await user.type(screen.getByRole("searchbox", { name: "Cihaz ara" }), "zzzz");
    expect(screen.getByText(/eşleşen cihaz yok/i)).toBeInTheDocument();
  });
});
