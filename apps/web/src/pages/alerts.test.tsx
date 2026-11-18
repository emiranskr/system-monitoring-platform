import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AlertsPage } from "./AlertsPage";
import { RequireAuth } from "../session/RequireAuth";
import { SessionProvider } from "../session/SessionProvider";
import { mockFetch, type MockCall } from "../test/mockFetch";

const D1 = "11111111-1111-4111-8111-111111111111";
const R1 = "22222222-2222-4222-8222-222222222222";
const RB = "22222222-2222-4222-8222-222222222223";
const C1 = "33333333-3333-4333-8333-333333333333";
const T = "2026-11-18T12:00:00.000Z";

const rule = (over: Record<string, unknown> = {}) => ({
  id: R1, name: "CPU yuksek", metric: "cpu.total", agg: "avg", window_seconds: 60, operator: ">", threshold: 90, hysteresis: 0, for_seconds: 120, severity: "warning",
  scope_device_ids: null, channel_ids: [], builtin: null, enabled: true, created_at: T, updated_at: T, ...over,
});
const incident = (over: Record<string, unknown> = {}) => ({
  id: "44444444-4444-4444-8444-444444444444", rule_id: R1, rule_name: "CPU yuksek", device_id: D1, device_name: "pc-01", metric: "cpu.total", severity: "critical",
  opened_at: T, resolved_at: null, last_value: 95, peak_value: 99, ...over,
});
const channel = (over: Record<string, unknown> = {}) => ({ id: C1, name: "slack", type: "webhook", summary: { host: "hooks.example.com" }, created_at: T, ...over });

interface Setup { role?: "owner" | "admin" | "viewer"; open?: unknown[]; resolved?: unknown[]; rules?: unknown[]; channels?: unknown[]; extra?: Record<string, (c: MockCall) => { status: number; body?: unknown }> }
function renderAlerts(s: Setup = {}) {
  const m = mockFetch({
    "GET /api/v1/me": () => ({ status: 200, body: { email: "ali@example.com", role: s.role ?? "admin" } }),
    "GET /api/v1/incidents": (c) => ({ status: 200, body: { incidents: new URL(c.url, "http://x").searchParams.get("state") === "open" ? (s.open ?? []) : (s.resolved ?? []) } }),
    "GET /api/v1/alert-rules": () => ({ status: 200, body: { rules: s.rules ?? [rule()] } }),
    "GET /api/v1/notification-channels": () => ({ status: 200, body: { channels: s.channels ?? [] } }),
    ...(s.extra ?? {}),
  });
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={["/uyarilar"]}>
        <SessionProvider><Routes><Route path="/uyarilar" element={<RequireAuth><AlertsPage /></RequireAuth>} /></Routes></SessionProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return m;
}
afterEach(() => vi.unstubAllGlobals());
const tab = async (name: string) => { await userEvent.setup().click(await screen.findByRole("tab", { name })); };

describe("Uyarilar sayfasi", () => {
  it("sekmeler: Aktif, Gecmis, Kurallar, Kanallar; bos durumlar acik metinle", async () => {
    renderAlerts();
    const list = await screen.findByRole("tablist", { name: "Uyarı bölümleri" });
    expect(within(list).getAllByRole("tab").map((t) => t.textContent)).toEqual(["Aktif", "Geçmiş", "Kurallar", "Kanallar"]);
    expect(await screen.findByText("Aktif uyarı yok.")).toBeInTheDocument();
    await tab("Geçmiş");
    expect(await screen.findByText("Çözülmüş uyarı yok.")).toBeInTheDocument();
    await tab("Kanallar");
    expect(await screen.findByText("Henüz bildirim kanalı yok.")).toBeInTheDocument();
  });

  it("aktif olay: onem (ikon+METIN), kural, cihaz baglantisi, deger ve tepe degeri", async () => {
    renderAlerts({ open: [incident()] });
    const row = (await screen.findByText("CPU yuksek")).closest("tr")!;
    expect(within(row).getByText("Kritik")).toBeInTheDocument();
    expect(within(row).getByRole("link", { name: "pc-01" })).toHaveAttribute("href", `/cihaz/${D1}`);
    expect(within(row).getByText(/95 \(tepe 99\)/)).toBeInTheDocument();
    expect(within(row).getByText("CPU kullanımı")).toBeInTheDocument();
  });

  it("gecmis olaylarda 'Cozuldu' sutunu var", async () => {
    renderAlerts({ resolved: [incident({ resolved_at: "2026-11-18T12:30:00.000Z" })] });
    await tab("Geçmiş");
    expect(await screen.findByRole("columnheader", { name: "Çözüldü" })).toBeInTheDocument();
  });

  it("XSS: kural, cihaz ve kanal adlari METIN olarak basilir (img/script olusmaz)", async () => {
    const evil = `<img src=x onerror="window.__xss=1">`;
    renderAlerts({ open: [incident({ rule_name: evil, device_name: evil })], rules: [rule({ name: evil })], channels: [channel({ name: evil })] });
    expect((await screen.findAllByText(evil)).length).toBeGreaterThan(0);
    await tab("Kurallar");
    expect((await screen.findAllByText(evil)).length).toBeGreaterThanOrEqual(1);
    await tab("Kanallar");
    expect((await screen.findAllByText(evil)).length).toBeGreaterThanOrEqual(1);
    expect(document.querySelector("img[src='x']")).toBeNull();
    expect((window as unknown as { __xss?: number }).__xss).toBeUndefined();
  });

  it("viewer: yazma kontrolleri YOK (Kural ekle, Kanal ekle, devre disi, sil, test)", async () => {
    renderAlerts({ role: "viewer", channels: [channel()] });
    await tab("Kurallar");
    expect(await screen.findByText("CPU yuksek")).toBeInTheDocument();
    for (const n of [/kural ekle/i, /devre dışı bırak/i, /^sil/i]) expect(screen.queryByRole("button", { name: n })).toBeNull();
    await tab("Kanallar");
    await screen.findByText("slack");
    for (const n of [/kanal ekle/i, /test gönder/i, /^sil/i]) expect(screen.queryByRole("button", { name: n })).toBeNull();
  });

  it("yerlesik kural: 'Yerlesik' etiketi, silme dugmesi YOK; etkinlestirme/devre disi var", async () => {
    renderAlerts({ rules: [rule({ id: RB, name: "Cihaz çevrimdışı", metric: "device.offline", builtin: "offline", threshold: 60, severity: "critical" })] });
    await tab("Kurallar");
    const li = (await screen.findByText("Cihaz çevrimdışı")).closest("li")!;
    expect(within(li).getByText("Yerleşik")).toBeInTheDocument();
    expect(within(li).queryByRole("button", { name: /^sil/i })).toBeNull();
    expect(within(li).getByRole("button", { name: /devre dışı bırak/i })).toBeInTheDocument();
    expect(within(li).getByText(/Cihaz çevrimdışı süresi > 60 sn/)).toBeInTheDocument();
  });

  it("kural ekleme: izin listesindeki metrik ve dogru JSON govdesi gonderilir; liste yenilenir; gecersiz esikte istek GITMEZ", async () => {
    const m = renderAlerts({ channels: [channel()], extra: { "POST /api/v1/alert-rules": () => ({ status: 201, body: rule({ name: "GPU sicak" }) }) } });
    const user = userEvent.setup();
    await tab("Kurallar");
    await user.click(await screen.findByRole("button", { name: /kural ekle/i }));
    const dlg = await screen.findByRole("dialog", { name: "Uyarı kuralı ekle" });
    await user.type(within(dlg).getByLabelText("Kural adı"), "GPU sicak");
    await user.selectOptions(within(dlg).getByLabelText("Metrik"), "gpu.*.temp_c");
    await user.selectOptions(within(dlg).getByLabelText("Toplama"), "max");
    await user.clear(within(dlg).getByLabelText("Eşik")); await user.type(within(dlg).getByLabelText("Eşik"), "abc");
    await user.click(within(dlg).getByRole("button", { name: "Kaydet" }));
    expect(await within(dlg).findByRole("alert")).toHaveTextContent("Eşik sayı olmalı");
    expect(m.calls.some((c) => c.method === "POST")).toBe(false);

    await user.clear(within(dlg).getByLabelText("Eşik")); await user.type(within(dlg).getByLabelText("Eşik"), "85");
    await user.click(within(dlg).getByRole("checkbox", { name: "slack" }));
    await user.click(within(dlg).getByRole("button", { name: "Kaydet" }));
    await waitFor(() => expect(m.calls.some((c) => c.method === "POST")).toBe(true));
    const post = m.calls.find((c) => c.method === "POST")!;
    expect(post.body).toEqual({
      name: "GPU sicak", metric: "gpu.*.temp_c", agg: "max", window_seconds: 60, operator: ">", threshold: 85, hysteresis: 0, for_seconds: 120, severity: "warning",
      scope_device_ids: null, channel_ids: [C1], enabled: true,
    });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("kural silme: iki adimli onay; DELETE istegi; devre disi birakma PATCH (yalniz enabled)", async () => {
    const m = renderAlerts({ extra: {
      [`DELETE /api/v1/alert-rules/${R1}`]: () => ({ status: 204 }),
      [`PATCH /api/v1/alert-rules/${R1}`]: () => ({ status: 200, body: rule({ enabled: false }) }),
    } });
    const user = userEvent.setup();
    await tab("Kurallar");
    await user.click(await screen.findByRole("button", { name: /devre dışı bırak/i }));
    await waitFor(() => expect(m.calls.find((c) => c.method === "PATCH")).toBeTruthy());
    expect(m.calls.find((c) => c.method === "PATCH")!.body).toEqual({ enabled: false });

    await user.click(screen.getByRole("button", { name: /^sil/i }));
    expect(m.calls.some((c) => c.method === "DELETE")).toBe(false);          // onay beklenir
    await user.click(await screen.findByRole("button", { name: /evet, sil/i }));
    await waitFor(() => expect(m.calls.some((c) => c.method === "DELETE")).toBe(true));
  });

  it("I-4: yerlesik kurala da kanal baglanabilir (Kanallari duzenle -> PATCH yalniz channel_ids)", async () => {
    const m = renderAlerts({ rules: [rule({ builtin: "offline", name: "Cihaz cevrimdisi" })], channels: [channel()], extra: {
      [`PATCH /api/v1/alert-rules/${R1}`]: () => ({ status: 200, body: rule({ channel_ids: [C1] }) }),
    } });
    const user = userEvent.setup();
    await tab("Kurallar");
    await user.click(await screen.findByRole("button", { name: /kanalları düzenle/i }));
    await user.click(screen.getByRole("checkbox", { name: "slack" }));
    await user.click(screen.getByRole("button", { name: /kanalları kaydet/i }));
    await waitFor(() => expect(m.calls.find((c) => c.method === "PATCH")).toBeTruthy());
    expect(m.calls.find((c) => c.method === "PATCH")!.body).toEqual({ channel_ids: [C1] });
  });

  it("I-4: viewer 'Kanallari duzenle' goremez", async () => {
    renderAlerts({ role: "viewer", channels: [channel()] });
    await tab("Kurallar");
    await screen.findByRole("list", { name: "Uyarı kuralları" });
    expect(screen.queryByRole("button", { name: /kanalları düzenle/i })).toBeNull();
  });

  it("webhook kanali: SIR alani password; gonderim sonrasi alanlar sifirlanir ve yanit/sayfada SIR YOK", async () => {
    const m = renderAlerts({ extra: { "POST /api/v1/notification-channels": () => ({ status: 201, body: channel({ name: "yeni" }) }) } });
    const user = userEvent.setup();
    await tab("Kanallar");
    await user.click(await screen.findByRole("button", { name: /kanal ekle/i }));
    const dlg = await screen.findByRole("dialog", { name: "Bildirim kanalı ekle" });
    expect(within(dlg).getByLabelText(/mza sırrı/)).toHaveAttribute("type", "password");
    await user.type(within(dlg).getByLabelText("Kanal adı"), "yeni");
    await user.type(within(dlg).getByLabelText(/webhook adresi/i), "https://hooks.example.com/services/GIZLI-TOKEN");
    await user.type(within(dlg).getByLabelText(/mza sırrı/), "SIRRI-123");
    await user.click(within(dlg).getByRole("button", { name: "Kaydet" }));
    await waitFor(() => expect(m.calls.some((c) => c.method === "POST")).toBe(true));
    expect(m.calls.find((c) => c.method === "POST")!.body).toEqual({ type: "webhook", name: "yeni", url: "https://hooks.example.com/services/GIZLI-TOKEN", secret: "SIRRI-123" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.body.innerHTML).not.toContain("GIZLI-TOKEN");
    expect(document.body.innerHTML).not.toContain("SIRRI-123");
    // dialog yeniden acilinca alanlar bos
    await user.click(await screen.findByRole("button", { name: /kanal ekle/i }));
    expect(within(await screen.findByRole("dialog")).getByLabelText(/webhook adresi/i)).toHaveValue("");
  });

  it("http:// webhook istemcide reddedilir (istek gitmez); sunucu hatalari (blocked_target, secrets_unavailable) anlasilir metinle", async () => {
    let status = 400, code = "blocked_target";
    const m = renderAlerts({ extra: { "POST /api/v1/notification-channels": () => ({ status, body: { error: code } }) } });
    const user = userEvent.setup();
    await tab("Kanallar");
    await user.click(await screen.findByRole("button", { name: /kanal ekle/i }));
    const dlg = await screen.findByRole("dialog");
    await user.type(within(dlg).getByLabelText("Kanal adı"), "k");
    await user.type(within(dlg).getByLabelText(/webhook adresi/i), "http://hooks.example.com/x");
    await user.click(within(dlg).getByRole("button", { name: "Kaydet" }));
    expect(await within(dlg).findByRole("alert")).toHaveTextContent("https://");
    expect(m.calls.some((c) => c.method === "POST")).toBe(false);

    await user.clear(within(dlg).getByLabelText(/webhook adresi/i));
    await user.type(within(dlg).getByLabelText(/webhook adresi/i), "https://10.0.0.5/x");
    await user.click(within(dlg).getByRole("button", { name: "Kaydet" }));
    expect(await within(dlg).findByText(/güvenlik nedeniyle reddedildi/i)).toBeInTheDocument();
    status = 503; code = "secrets_unavailable";
    await user.click(within(dlg).getByRole("button", { name: "Kaydet" }));
    expect(await within(dlg).findByText(/CHANNEL_KEY/)).toBeInTheDocument();
  });

  it("e-posta kanali: alici listesi ayristirilir; parola alani password; govde dogru", async () => {
    const m = renderAlerts({ extra: { "POST /api/v1/notification-channels": () => ({ status: 201, body: channel({ type: "email", summary: { host: "smtp.example.com", port: 587, recipients: 2 } }) }) } });
    const user = userEvent.setup();
    await tab("Kanallar");
    await user.click(await screen.findByRole("button", { name: /kanal ekle/i }));
    const dlg = await screen.findByRole("dialog");
    await user.selectOptions(within(dlg).getByLabelText("Tür"), "email");
    await user.type(within(dlg).getByLabelText("Kanal adı"), "posta");
    await user.type(within(dlg).getByLabelText("SMTP sunucusu"), "smtp.example.com");
    await user.type(within(dlg).getByLabelText("Kullanıcı (isteğe bağlı)"), "u");
    expect(within(dlg).getByLabelText("Parola")).toHaveAttribute("type", "password");
    await user.type(within(dlg).getByLabelText("Parola"), "p");
    await user.type(within(dlg).getByLabelText("Gönderen"), "alarm@example.com");
    await user.type(within(dlg).getByLabelText(/alıcılar/i), "a@example.com, b@example.com");
    await user.click(within(dlg).getByRole("button", { name: "Kaydet" }));
    await waitFor(() => expect(m.calls.some((c) => c.method === "POST")).toBe(true));
    expect(m.calls.find((c) => c.method === "POST")!.body).toEqual({
      type: "email", name: "posta", host: "smtp.example.com", port: 587, secure: false, user: "u", pass: "p", from: "alarm@example.com", to: ["a@example.com", "b@example.com"],
    });
  });

  it("kanal listesi: webhook yalniz ana makine, e-posta sunucu:port ve alici sayisi; test gonder ve silme", async () => {
    const m = renderAlerts({
      channels: [channel(), channel({ id: "55555555-5555-4555-8555-555555555555", name: "posta", type: "email", summary: { host: "smtp.example.com", port: 587, recipients: 2 } })],
      extra: { [`POST /api/v1/notification-channels/${C1}/test`]: () => ({ status: 202, body: { queued: true } }), [`DELETE /api/v1/notification-channels/${C1}`]: () => ({ status: 204 }) },
    });
    const user = userEvent.setup();
    await tab("Kanallar");
    expect(await screen.findByText(/Webhook · hooks\.example\.com/)).toBeInTheDocument();
    expect(screen.getByText(/E-posta · smtp\.example\.com:587 · 2 alıcı/)).toBeInTheDocument();
    await user.click(screen.getAllByRole("button", { name: /test gönder/i })[0]!);
    expect(await screen.findByRole("status")).toHaveTextContent("kuyruğa alındı");
    await user.click(screen.getAllByRole("button", { name: /^sil/i })[0]!);
    await user.click(await screen.findByRole("button", { name: /evet, sil/i }));
    await waitFor(() => expect(m.calls.some((c) => c.method === "DELETE")).toBe(true));
  });

  it("hata durumu: olay listesi 500 ise ErrorState ve 'Yeniden dene'", async () => {
    mockFetch({
      "GET /api/v1/me": () => ({ status: 200, body: { email: "a@example.com", role: "admin" } }),
      "GET /api/v1/incidents": () => ({ status: 500, body: { error: "internal" } }),
      "GET /api/v1/notification-channels": () => ({ status: 200, body: { channels: [] } }),
    });
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter initialEntries={["/uyarilar"]}><SessionProvider><Routes><Route path="/uyarilar" element={<RequireAuth><AlertsPage /></RequireAuth>} /></Routes></SessionProvider></MemoryRouter>
      </QueryClientProvider>,
    );
    expect((await screen.findAllByRole("alert"))[0]).toHaveTextContent("Sunucu hatası");
    expect(screen.getAllByRole("button", { name: "Yeniden dene" }).length).toBeGreaterThan(0);
  });
});
