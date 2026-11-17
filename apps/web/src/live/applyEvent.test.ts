import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import type { DeviceDetail, DevicesResponse, SampleEventPayload } from "@sysmon/protocol";
import { applyEvent } from "./applyEvent";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const dev = (id: string, over: Record<string, unknown> = {}) => ({ id, name: id === A ? "a" : "b", status: "stale", last_seen_at: "2026-11-17T11:00:00.000Z", cpu_pct: 1, mem_pct: 2, disk_used_pct: 3, ...over });
const ev = (over: Partial<SampleEventPayload> = {}, values: SampleEventPayload["values"] = {}): SampleEventPayload => ({ device_id: A, t: "2026-11-17T12:00:00.000Z", values: { ...values }, ...over });
const seed = (devices: unknown[]) => { const qc = new QueryClient(); qc.setQueryData(["devices"], { devices }); return qc; };
const read = (qc: QueryClient) => (qc.getQueryData(["devices"]) as DevicesResponse).devices;

describe("applyEvent: SSE olayi -> sorgu onbellegi", () => {
  it("cpu/bellek guncellenir, en yuksek disk secilir, durum online, son gorulme olay zamani", () => {
    const qc = seed([dev(A), dev(B)]);
    applyEvent(qc, ev({}, { "cpu.total": 77, "mem.used_pct": 55, "disk.c.used_pct": 40, "disk.d.used_pct": 91 }));
    expect(read(qc)[0]).toMatchObject({ id: A, status: "online", cpu_pct: 77, mem_pct: 55, disk_used_pct: 91, last_seen_at: "2026-11-17T12:00:00.000Z" });
  });

  it("baska cihaza DOKUNMAZ", () => {
    const qc = seed([dev(A), dev(B)]);
    applyEvent(qc, ev({}, { "cpu.total": 99 }));
    expect(read(qc)[1]).toEqual(dev(B));
  });

  it("olayda olmayan alanlar ESKI degerini korur; NULL gelen alan NULL olur (donanim yok)", () => {
    const qc = seed([dev(A)]);
    applyEvent(qc, ev({}, { "cpu.total": null }));
    expect(read(qc)[0]).toMatchObject({ cpu_pct: null, mem_pct: 2, disk_used_pct: 3 });
  });

  it("disk degerlerinin hepsi NULL ise disk NULL; hic disk anahtari yoksa eski deger", () => {
    const qc = seed([dev(A)]);
    applyEvent(qc, ev({}, { "disk.c.used_pct": null }));
    expect(read(qc)[0]!.disk_used_pct).toBeNull();
    const qc2 = seed([dev(A)]);
    applyEvent(qc2, ev({}, { "cpu.total": 5 }));
    expect(read(qc2)[0]!.disk_used_pct).toBe(3);
  });

  it("iptal edilmis cihaz 'revoked' KALIR (olay onu canlandirmaz)", () => {
    const qc = seed([dev(A, { status: "revoked" })]);
    applyEvent(qc, ev({}, { "cpu.total": 5 }));
    expect(read(qc)[0]!.status).toBe("revoked");
  });

  it("son_gorulme GERIYE gitmez (eski zamanli olay mevcut degeri ezmez)", () => {
    const qc = seed([dev(A, { last_seen_at: "2026-11-17T13:00:00.000Z" })]);
    applyEvent(qc, ev({ t: "2026-11-17T12:00:00.000Z" }, { "cpu.total": 5 }));
    expect(read(qc)[0]!.last_seen_at).toBe("2026-11-17T13:00:00.000Z");
  });

  it("bilinmeyen cihaz: liste onbellegi GECERSIZ kilinir (yeniden cekilir), onbellek bozulmaz", () => {
    const qc = seed([dev(B)]);
    const spy = vi.spyOn(qc, "invalidateQueries");
    applyEvent(qc, ev({}, { "cpu.total": 5 }));
    expect(spy).toHaveBeenCalledWith({ queryKey: ["devices"] });
    expect(read(qc)).toEqual([dev(B)]);
  });

  it("liste onbellekte yoksa: hicbir sey yapmaz (cokmez)", () => {
    const qc = new QueryClient();
    expect(() => applyEvent(qc, ev({}, { "cpu.total": 5 }))).not.toThrow();
    expect(qc.getQueryData(["devices"])).toBeUndefined();
  });

  it("cihaz detayi onbellegi varsa son gorulme/durum guncellenir", () => {
    const qc = seed([dev(A)]);
    const detail: DeviceDetail = { id: A, name: "a", status: "stale", last_seen_at: "2026-11-17T11:00:00.000Z", device_info: null };
    qc.setQueryData(["device", A], detail);
    applyEvent(qc, ev({}, { "cpu.total": 5 }));
    expect(qc.getQueryData(["device", A])).toMatchObject({ status: "online", last_seen_at: "2026-11-17T12:00:00.000Z" });
  });
});
