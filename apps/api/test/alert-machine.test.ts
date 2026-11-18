import { describe, expect, it } from "vitest";
import { step, type MachineState, type RuleParams } from "../src/alerts/machine.js";

const T0 = new Date("2026-11-18T12:00:00Z");
const at = (sec: number) => new Date(T0.getTime() + sec * 1000);
const OK: MachineState = { state: "ok", pendingSince: null };
const gt = (over: Partial<RuleParams> = {}): RuleParams => ({ operator: ">", threshold: 90, hysteresis: 0, forSeconds: 60, ...over });

describe("alert durum makinesi: OK -> PENDING -> FIRING -> RESOLVED", () => {
  it("for=0: ihlalde dogrudan FIRING (fire gecisi)", () => {
    const r = step(OK, 95, T0, gt({ forSeconds: 0 }));
    expect(r.next.state).toBe("firing");
    expect(r.transition).toBe("fire");
  });

  it("for>0: ihlalde PENDING, sure DOLUNCA FIRING (tam sinir: bir ms once degil)", () => {
    let r = step(OK, 95, T0, gt());
    expect(r.next).toEqual({ state: "pending", pendingSince: T0 });
    expect(r.transition).toBeNull();
    r = step(r.next, 95, new Date(at(60).getTime() - 1), gt());
    expect(r.next.state).toBe("pending");
    r = step(r.next, 95, at(60), gt());
    expect(r.next.state).toBe("firing");
    expect(r.transition).toBe("fire");
  });

  it("PENDING iken ihlal biterse OK'e doner ve sayac sifirlanir (bildirim YOK)", () => {
    let r = step(OK, 95, T0, gt());
    r = step(r.next, 50, at(30), gt());
    expect(r.next).toEqual({ state: "ok", pendingSince: null });
    expect(r.transition).toBeNull();
    r = step(r.next, 95, at(40), gt());                      // yeniden ihlal: sayac BASTAN
    r = step(r.next, 95, at(40 + 59), gt());
    expect(r.next.state).toBe("pending");
    expect(step(r.next, 95, at(40 + 60), gt()).transition).toBe("fire");
  });

  it.each([
    // operator, esik, histerezis, ihlal degeri, bantta (hala FIRING) deger, cozen deger
    [">", 90, 5, 91, 86, 85],
    [">=", 90, 5, 90, 86, 84.9],
    ["<", 10, 5, 9, 14, 15],
    ["<=", 10, 5, 10, 14, 15.1],
  ] as const)("FIRING: operator %s histerezis bandinda cozulmez, bandin otesinde cozulur", (operator, threshold, hysteresis, breach, band, clear) => {
    const p: RuleParams = { operator, threshold, hysteresis, forSeconds: 0 };
    let r = step(OK, breach, T0, p);
    expect(r.transition).toBe("fire");
    r = step(r.next, band, at(15), p);
    expect(r.next.state).toBe("firing");
    expect(r.transition).toBeNull();
    r = step(r.next, clear, at(30), p);
    expect(r.next.state).toBe("ok");
    expect(r.transition).toBe("resolve");
  });

  it("histerezis 0: ihlal bitince hemen cozulur (esikte >: 90 ihlal degil)", () => {
    let r = step(OK, 91, T0, gt({ forSeconds: 0 }));
    r = step(r.next, 90, at(15), gt({ forSeconds: 0 }));
    expect(r.transition).toBe("resolve");
  });

  it("veri yok (null): hicbir durumda gecis olmaz (PENDING/FIRING korunur)", () => {
    const pending = step(OK, 95, T0, gt()).next;
    expect(step(pending, null, at(15), gt())).toEqual({ next: pending, transition: null });
    const firing: MachineState = { state: "firing", pendingSince: null };
    expect(step(firing, null, at(15), gt())).toEqual({ next: firing, transition: null });
    expect(step(OK, null, at(15), gt())).toEqual({ next: OK, transition: null });
  });

  it("cozulduktan sonra yeniden tetiklenebilir (yeni olay)", () => {
    const p = gt({ forSeconds: 0 });
    let r = step(OK, 95, T0, p);
    r = step(r.next, 10, at(15), p);
    expect(r.transition).toBe("resolve");
    r = step(r.next, 95, at(30), p);
    expect(r.transition).toBe("fire");
  });

  it("FLAPPING 1 SAAT (15 sn adim, esik etrafinda surekli salinim, for=60): SIFIR bildirim", () => {
    const p = gt({ forSeconds: 60 });
    let s = OK;
    let fires = 0, resolves = 0;
    for (let i = 0; i < 240; i++) {                          // 240 x 15 sn = 1 saat
      const r = step(s, i % 2 === 0 ? 95 : 85, at(i * 15), p);
      s = r.next;
      if (r.transition === "fire") fires++;
      if (r.transition === "resolve") resolves++;
    }
    expect({ fires, resolves }).toEqual({ fires: 0, resolves: 0 });
  });

  it("FLAPPING histerezis bandinda 1 SAAT: tam 1 fire, 0 resolve (yinelenen bildirim yok)", () => {
    const p = gt({ forSeconds: 0, hysteresis: 5 });
    let s = OK;
    let fires = 0, resolves = 0;
    for (let i = 0; i < 240; i++) {
      const r = step(s, i % 2 === 0 ? 91 : 87, at(i * 15), p);   // 87: ihlal degil ama bant icinde (> 85)
      s = r.next;
      if (r.transition === "fire") fires++;
      if (r.transition === "resolve") resolves++;
    }
    expect({ fires, resolves }).toEqual({ fires: 1, resolves: 0 });
  });

  it("gecersiz parametre reddedilir (NaN esik, negatif sure/histerezis)", () => {
    expect(() => step(OK, 1, T0, gt({ threshold: NaN }))).toThrow();
    expect(() => step(OK, 1, T0, gt({ forSeconds: -1 }))).toThrow();
    expect(() => step(OK, 1, T0, gt({ hysteresis: -1 }))).toThrow();
    expect(() => step(OK, NaN, T0, gt())).toThrow();
  });
});
