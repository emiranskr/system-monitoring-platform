import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const plots = vi.hoisted(() => [] as { opts: unknown; data: (number | null)[][] }[]);
vi.mock("uplot", () => ({
  default: class {
    constructor(opts: unknown, data: (number | null)[][]) { plots.push({ opts, data }); }
    setData() {}
    setSize() {}
    destroy() {}
  },
}));
vi.mock("uplot/dist/uPlot.min.css", () => ({}));

import { DevicePage } from "./DevicePage";
import { RequireAuth } from "../session/RequireAuth";
import { SessionProvider } from "../session/SessionProvider";
import { mockFetch, type MockCall } from "../test/mockFetch";

const ID = "11111111-1111-4111-8111-111111111111";
const ME = { email: "ali@example.com", role: "admin" };
const T = (sec: number) => new Date(1_700_000_000_000 + sec * 1000).toISOString();
const INFO = { hostname: "pc-01", os: "Windows 11", agent_version: "0.1.0", gpus: [], adapters: [{ id: "wifi0", name: "Wi-Fi" }], volumes: [{ id: "C", name: "C:" }] };
const detail = (over: Record<string, unknown> = {}) => ({ id: ID, name: "pc-01", status: "online", last_seen_at: new Date(Date.now() - 5000).toISOString(), device_info: INFO, ...over });
const series = (metric: string, points: { t: string; avg: number; min?: number; max?: number }[], bucket = 10) => ({
  metric, from: T(0), to: T(3600), source: "raw", bucket_seconds: bucket, points: points.map((p) => ({ t: p.t, avg: p.avg, min: p.min ?? p.avg, max: p.max ?? p.avg })),
});

interface Opts { names?: string[]; detailBody?: unknown; detailStatus?: number; seriesFor?: (metric: string, call: MockCall) => unknown }
function renderDevice(opts: Opts = {}) {
  const names = opts.names ?? ["cpu.total", "mem.used_pct", "disk.c.used_pct", "net.wifi0.rx_bps", "net.wifi0.tx_bps"];
  const m = mockFetch({
    "GET /api/v1/me": () => ({ status: 200, body: ME }),
    [`GET /api/v1/devices/${ID}`]: () => ({ status: opts.detailStatus ?? 200, body: opts.detailBody ?? detail() }),
    [`GET /api/v1/devices/${ID}/metric-names`]: () => ({ status: 200, body: { metrics: names.map((n) => ({ name: n, last_ts: T(0) })) } }),
    [`GET /api/v1/devices/${ID}/metrics`]: (call) => {
      const metric = new URL(call.url, "http://x").searchParams.get("metric")!;
      return { status: 200, body: opts.seriesFor ? opts.seriesFor(metric, call) : series(metric, [{ t: T(0), avg: 10, min: 5, max: 20 }, { t: T(10), avg: 20, min: 10, max: 30 }, { t: T(20), avg: 30, min: 20, max: 40 }]) };
    },
  });
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={[`/cihaz/${ID}`]}>
        <SessionProvider>
          <Routes><Route path="/cihaz/:id" element={<RequireAuth><DevicePage /></RequireAuth>} /></Routes>
        </SessionProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return m;
}
const seriesCalls = (m: ReturnType<typeof mockFetch>) => m.calls.filter((c) => c.url.includes("/metrics?"));
const qp = (c: MockCall) => new URL(c.url, "http://x").searchParams;

beforeEach(() => { plots.length = 0; });
afterEach(() => vi.unstubAllGlobals());

describe("Cihaz detayi: baslik ve hata durumlari", () => {
  it("ad, durum rozeti ve son gorulme", async () => {
    renderDevice();
    expect(await screen.findByRole("heading", { level: 1, name: "pc-01" })).toBeInTheDocument();
    expect(screen.getByText("Çevrimiçi")).toBeInTheDocument();
    expect(screen.getByText(/son görülme/i)).toHaveTextContent(/5 sn önce/);
  });

  it("404 -> 'Bulunamadi' (varlik ipucu yok), baska icerik yok", async () => {
    renderDevice({ detailStatus: 404, detailBody: { error: "not_found" } });
    expect(await screen.findByRole("alert")).toHaveTextContent("Bulunamadı");
    expect(screen.queryByRole("tablist")).toBeNull();
  });

  it("sozlesme ihlali -> acik hata, 'undefined' yok", async () => {
    renderDevice({ detailBody: { id: ID } });
    expect(await screen.findByRole("alert")).toHaveTextContent(/beklenmeyen yanıt/i);
    expect(document.body.textContent).not.toContain("undefined");
  });

  it("XSS: cihaz adi metin olarak (img/script yok)", async () => {
    const evil = "<img src=x onerror=alert(1)><script>alert(2)</script>";
    renderDevice({ detailBody: detail({ name: evil }) });
    expect(await screen.findByRole("heading", { level: 1, name: evil })).toBeInTheDocument();
    expect(document.querySelector("img[src='x']")).toBeNull();
    expect(document.querySelector("main script, h1 script")).toBeNull();
  });
});

describe("sekmeler ve metrik kesfi", () => {
  it("tablist: Genel, CPU, Bellek, Depolama, Ag, Bilgi; varsayilan Genel secili", async () => {
    renderDevice();
    const list = await screen.findByRole("tablist", { name: "Cihaz bölümleri" });
    expect(within(list).getAllByRole("tab").map((t) => t.textContent)).toEqual(["Genel", "CPU", "Bellek", "Depolama", "Ağ", "Bilgi"]);
    expect(within(list).getByRole("tab", { name: "Genel" })).toHaveAttribute("aria-selected", "true");
  });

  it("Genel: CPU ve Bellek grafikleri (uPlot) kurulur", async () => {
    renderDevice();
    expect(await screen.findByRole("img", { name: "CPU kullanımı" })).toBeInTheDocument();
    expect(await screen.findByRole("img", { name: "Bellek kullanımı" })).toBeInTheDocument();
    expect(plots.length).toBeGreaterThanOrEqual(2);
  });

  it("olmayan metrik: 'Bu donanimda yok' (sifir CIZILMEZ, grafik kurulmaz)", async () => {
    renderDevice({ names: ["cpu.total"] });
    await screen.findByRole("img", { name: "CPU kullanımı" });
    const user = userEvent.setup();
    await user.click(screen.getByRole("tab", { name: "Bellek" }));
    expect(await screen.findByText(/bu donanımda yok/i)).toBeInTheDocument();
    expect(screen.queryByRole("img", { name: "Bellek kullanımı" })).toBeNull();
    await user.click(screen.getByRole("tab", { name: "Depolama" }));
    expect(await screen.findByText(/bu donanımda yok/i)).toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "Ağ" }));
    expect(await screen.findByText(/bu donanımda yok/i)).toBeInTheDocument();
  });

  it("Depolama: her disk icin grafik; Ag: adaptor adi device_info'dan (Wi-Fi), rx/tx ayri", async () => {
    renderDevice({ names: ["cpu.total", "disk.c.used_pct", "disk.d.used_pct", "net.wifi0.rx_bps", "net.wifi0.tx_bps", "net.bilinmeyen.rx_bps"] });
    const user = userEvent.setup();
    await screen.findByRole("tablist");
    await user.click(screen.getByRole("tab", { name: "Depolama" }));
    expect(await screen.findByRole("img", { name: "Disk C: doluluk" })).toBeInTheDocument();
    expect(await screen.findByRole("img", { name: "Disk D: doluluk" })).toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "Ağ" }));
    expect(await screen.findByRole("heading", { name: "Wi-Fi" })).toBeInTheDocument();
    expect(await screen.findByRole("img", { name: "Wi-Fi alınan" })).toBeInTheDocument();
    expect(await screen.findByRole("img", { name: "Wi-Fi gönderilen" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "bilinmeyen" })).toBeInTheDocument(); // eslesme yok: anahtar (ad UYDURULMAZ)
  });

  it("Bilgi: device_info alanlari METIN olarak; null ise 'Cihaz bilgisi yok'", async () => {
    const user = userEvent.setup();
    renderDevice({ detailBody: detail({ device_info: { ...INFO, hostname: "<script>alert(1)</script>", os: "x".repeat(128) } }) });
    await screen.findByRole("tablist");
    await user.click(screen.getByRole("tab", { name: "Bilgi" }));
    expect(await screen.findByText("<script>alert(1)</script>")).toBeInTheDocument();
    expect(document.querySelector("dl script")).toBeNull();
    expect(screen.getByText("0.1.0")).toBeInTheDocument();
  });

  it("device_info null: 'Cihaz bilgisi yok'", async () => {
    const user = userEvent.setup();
    renderDevice({ detailBody: detail({ device_info: null }) });
    await screen.findByRole("tablist");
    await user.click(screen.getByRole("tab", { name: "Bilgi" }));
    expect(await screen.findByText(/cihaz bilgisi yok/i)).toBeInTheDocument();
  });
});

describe("zaman araligi, yakinlastirma, veri tablosu", () => {
  it("varsayilan 1 sa; '24 sa' secince istek penceresi 24 saat ve max_points=600 (genislik bilinmiyor)", async () => {
    const m = renderDevice();
    const user = userEvent.setup();
    await screen.findByRole("img", { name: "CPU kullanımı" });
    expect(screen.getByRole("button", { name: "1 sa" })).toHaveAttribute("aria-pressed", "true");
    const first = qp(seriesCalls(m)[0]!);
    expect((Date.parse(first.get("to")!) - Date.parse(first.get("from")!)) / 3600_000).toBe(1);
    await user.click(screen.getByRole("button", { name: "24 sa" }));
    expect(screen.getByRole("button", { name: "24 sa" })).toHaveAttribute("aria-pressed", "true");
    await vi.waitFor(() => {
      const last = qp(seriesCalls(m).at(-1)!);
      expect((Date.parse(last.get("to")!) - Date.parse(last.get("from")!)) / 3600_000).toBe(24);
      expect(last.get("max_points")).toBe("600");
    });
  });

  it("klavyeyle Uzaklastir/Yakinlastir dugmeleri araligi onayarlar arasinda degistirir (fircaya alternatif)", async () => {
    renderDevice();
    const user = userEvent.setup();
    await screen.findByRole("img", { name: "CPU kullanımı" });
    await user.click(screen.getByRole("button", { name: "Uzaklaştır" }));
    expect(screen.getByRole("button", { name: "6 sa" })).toHaveAttribute("aria-pressed", "true");
    await user.click(screen.getByRole("button", { name: "Yakınlaştır" }));
    expect(screen.getByRole("button", { name: "1 sa" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Yakınlaştır" })).toBeDisabled(); // en kisa aralik
  });

  it("veri tablosu: grafikle ayni veriyi gosterir (satir sayisi = nokta sayisi), dugme aria-expanded", async () => {
    renderDevice();
    const user = userEvent.setup();
    const chart = (await screen.findByRole("img", { name: "CPU kullanımı" })).closest("section")!;
    const btn = within(chart).getByRole("button", { name: /tablo/i });
    expect(btn).toHaveAttribute("aria-expanded", "false");
    await user.click(btn);
    expect(btn).toHaveAttribute("aria-expanded", "true");
    const table = within(chart).getByRole("table");
    expect(within(table).getAllByRole("row")).toHaveLength(4); // baslik + 3 nokta
    expect(within(table).getByText("%40")).toBeInTheDocument();
  });

  it("ozet: son/min/ort/maks degerleri", async () => {
    renderDevice();
    const chart = (await screen.findByRole("img", { name: "CPU kullanımı" })).closest("section")!;
    expect(chart).toHaveTextContent("Son %30");
    expect(chart).toHaveTextContent("Min %5");
    expect(chart).toHaveTextContent("Ort %20");
    expect(chart).toHaveTextContent("Maks %40");
  });

  it("veri olmayan aralik: 'Secilen aralikta veri yok', uPlot kurulmaz", async () => {
    renderDevice({ names: ["cpu.total"], seriesFor: (metric) => series(metric, []) });
    expect(await screen.findByText(/seçilen aralıkta veri yok/i)).toBeInTheDocument();
    expect(plots).toHaveLength(0);
  });

  it("BOSLUK = KESINTI: uPlot'a arada null verilir (interpolasyon yok)", async () => {
    renderDevice({ names: ["cpu.total"], seriesFor: (metric) => series(metric, [{ t: T(0), avg: 1 }, { t: T(10), avg: 2 }, { t: T(600), avg: 3 }]) });
    await screen.findByRole("img", { name: "CPU kullanımı" });
    await vi.waitFor(() => expect(plots.length).toBeGreaterThan(0));
    const avg = plots.at(-1)!.data[1]!;
    expect(avg).toEqual([1, 2, null, 3]);
  });

  it("seri sozlesme ihlali: grafik yerine acik hata", async () => {
    renderDevice({ names: ["cpu.total"], seriesFor: () => ({ metric: "cpu.total", points: "bozuk" }) });
    expect(await screen.findByRole("alert")).toHaveTextContent(/beklenmeyen yanıt/i);
  });
});
