import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SampleEventPayload } from "@sysmon/protocol";
import { FakeEventSource } from "./fakeEventSource";
import { createLiveClient, type LiveStatus } from "./liveClient";

const ID = "11111111-1111-4111-8111-111111111111";
const payload: SampleEventPayload = { device_id: ID, t: "2026-11-17T12:00:00.000Z", values: { "cpu.total": 12, "gpu.temp": null } };

function setup(over: Partial<Parameters<typeof createLiveClient>[0]> = {}) {
  const statuses: LiveStatus[] = [];
  const events: SampleEventPayload[] = [];
  const client = createLiveClient({
    url: "/api/v1/stream", EventSourceImpl: FakeEventSource as unknown as typeof EventSource,
    onEvent: (p) => events.push(p), onStatus: (s) => statuses.push(s),
    backoff: { baseMs: 1000, maxMs: 30_000, jitter: (n) => n }, // jitter kimlik: sureler tam
    ...over,
  });
  return { client, statuses, events };
}

beforeEach(() => { vi.useFakeTimers(); FakeEventSource.reset(); });
afterEach(() => vi.useRealTimers());

describe("createLiveClient", () => {
  it("start: connecting; ready -> live", () => {
    const { client, statuses } = setup();
    client.start();
    expect(statuses).toEqual(["connecting"]);
    expect(FakeEventSource.last.url).toBe("/api/v1/stream");
    FakeEventSource.last.emit("ready", {});
    expect(statuses).toEqual(["connecting", "live"]);
  });

  it("start iki kez cagrilsa TEK akis", () => {
    const { client } = setup();
    client.start(); client.start();
    expect(FakeEventSource.instances).toHaveLength(1);
  });

  it("kopma: down + ustel geri cekilme 1s,2s,4s,... ust sinir 30s", () => {
    const { client, statuses } = setup();
    client.start();
    const delays: number[] = [];
    for (let i = 0; i < 8; i++) {
      const es = FakeEventSource.last;
      const before = FakeEventSource.instances.length;
      es.emit("error");
      expect(es.closed).toBe(true);
      let waited = 0;
      while (FakeEventSource.instances.length === before) { vi.advanceTimersByTime(250); waited += 250; if (waited > 40_000) throw new Error("yeniden baglanmadi"); }
      delays.push(waited);
    }
    expect(delays).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
    expect(statuses.filter((s) => s === "down").length).toBe(8);
  });

  it("yeniden baglanip ready gelince geri cekilme SIFIRLANIR", () => {
    const { client } = setup();
    client.start();
    FakeEventSource.last.emit("error"); vi.advanceTimersByTime(1000);   // 1. kopma -> 1s
    FakeEventSource.last.emit("error"); vi.advanceTimersByTime(2000);   // 2. kopma -> 2s
    FakeEventSource.last.emit("ready", {});                              // basarili baglanti
    const n = FakeEventSource.instances.length;
    FakeEventSource.last.emit("error");
    vi.advanceTimersByTime(999); expect(FakeEventSource.instances).toHaveLength(n);
    vi.advanceTimersByTime(1); expect(FakeEventSource.instances).toHaveLength(n + 1); // yine 1 sn
  });

  it("jitter uygulanir (gecikme jitter(n) kadar)", () => {
    const { client } = setup({ backoff: { baseMs: 1000, maxMs: 30_000, jitter: (n) => n / 2 } });
    client.start();
    FakeEventSource.last.emit("error");
    vi.advanceTimersByTime(499); expect(FakeEventSource.instances).toHaveLength(1);
    vi.advanceTimersByTime(1); expect(FakeEventSource.instances).toHaveLength(2);
  });

  it("'closed' olayi: status closed, akis kapanir, YENIDEN BAGLANMA YOK", () => {
    const { client, statuses } = setup();
    client.start();
    FakeEventSource.last.emit("ready", {});
    FakeEventSource.last.emit("closed", { reason: "session" });
    expect(statuses.at(-1)).toBe("closed");
    expect(FakeEventSource.last.closed).toBe(true);
    vi.advanceTimersByTime(120_000);
    expect(FakeEventSource.instances).toHaveLength(1);
  });

  it("gecerli 'sample' -> onEvent; sema disi/bozuk JSON YOK SAYILIR (invalid sayaci artar, cokmez)", () => {
    const { client, events } = setup();
    client.start();
    const es = FakeEventSource.last;
    es.emit("sample", payload);
    es.emit("sample", "bozuk{json");
    es.emit("sample", { device_id: "uuid-degil", t: "x", values: {} });
    es.emit("sample", { ...payload, values: { "cpu.total": "12" } });
    expect(events).toEqual([payload]);
    expect(client.invalid).toBe(3);
  });

  it("stop(): akis kapanir, bekleyen yeniden baglanma iptal, sonraki olaylar yoksayilir", () => {
    const { client, events, statuses } = setup();
    client.start();
    const es = FakeEventSource.last;
    es.emit("error"); // yeniden baglanma zamanlandi
    client.stop();
    vi.advanceTimersByTime(60_000);
    expect(FakeEventSource.instances).toHaveLength(1); // yeni akis yok
    es.emit("sample", payload);
    expect(events).toEqual([]);
    expect(statuses.at(-1)).toBe("down");
    expect(vi.getTimerCount()).toBe(0); // zamanlayici sizintisi yok
  });

  it("stop sonrasi tekrar start edilebilir", () => {
    const { client } = setup();
    client.start(); client.stop(); client.start();
    expect(FakeEventSource.instances).toHaveLength(2);
    expect(FakeEventSource.instances[0]!.closed).toBe(true);
  });
});
