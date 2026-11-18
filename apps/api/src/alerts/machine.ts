/**
 * Uyari durum makinesi (saf, saat disaridan verilir): OK -> PENDING -> FIRING -> (RESOLVED = OK'e donus + "resolve" gecisi).
 * - PENDING: ihlal basladi, `forSeconds` dolana kadar bildirim YOK; ihlal biterse OK'e doner (sayac sifirlanir).
 * - FIRING: ihlal bitse bile HISTEREZIS bandinda (esik - histerezis) cozulmez; yalniz bandin otesine gecince cozulur.
 * - Veri yok (null): FIRING korunur (asla otomatik cozulmez); PENDING sifirlanir (kesintisiz ihlal kaniti yok); OK kalir.
 * Yalnizca "fire" ve "resolve" gecisleri bildirim uretir: flapping tek bir yinelenen bildirim doguramaz.
 */
export type Operator = ">" | ">=" | "<" | "<=";
export type RuleState = "ok" | "pending" | "firing";

export interface MachineState { state: RuleState; pendingSince: Date | null }
export interface RuleParams { operator: Operator; threshold: number; hysteresis: number; forSeconds: number }
export interface Outcome { next: MachineState; transition: "fire" | "resolve" | null }

function breached(v: number, p: RuleParams): boolean {
  switch (p.operator) {
    case ">": return v > p.threshold;
    case ">=": return v >= p.threshold;
    case "<": return v < p.threshold;
    case "<=": return v <= p.threshold;
  }
}

/** FIRING'den cozulme: ihlal bitmis VE deger histerezis bandinin otesinde. */
function cleared(v: number, p: RuleParams): boolean {
  switch (p.operator) {
    case ">": return v <= p.threshold - p.hysteresis;
    case ">=": return v < p.threshold - p.hysteresis;
    case "<": return v >= p.threshold + p.hysteresis;
    case "<=": return v > p.threshold + p.hysteresis;
  }
}

export function step(prev: MachineState, value: number | null, now: Date, p: RuleParams): Outcome {
  if (!Number.isFinite(p.threshold) || !(p.forSeconds >= 0) || !(p.hysteresis >= 0)) throw new RangeError("gecersiz kural parametresi");
  if (value === null) {
    // Veri yok: FIRING ASLA otomatik cozulmez (cihaz sustu/ingest kesildi olabilir; cevrimdisi kurali ayrica yakalar). PENDING ise
    // sifirlanir: "for" suresi KESINTISIZ ihlal ister, veri bosluguyla dolmus sayilmaz.
    return prev.state === "pending" ? { next: { state: "ok", pendingSince: null }, transition: null } : { next: prev, transition: null };
  }
  if (!Number.isFinite(value)) throw new RangeError("gecersiz deger");

  switch (prev.state) {
    case "ok":
      if (!breached(value, p)) return { next: prev, transition: null };
      if (p.forSeconds === 0) return { next: { state: "firing", pendingSince: null }, transition: "fire" };
      return { next: { state: "pending", pendingSince: now }, transition: null };
    case "pending": {
      if (!breached(value, p)) return { next: { state: "ok", pendingSince: null }, transition: null };
      const since = prev.pendingSince ?? now;
      if (now.getTime() - since.getTime() >= p.forSeconds * 1000) return { next: { state: "firing", pendingSince: null }, transition: "fire" };
      return { next: { state: "pending", pendingSince: since }, transition: null };
    }
    case "firing":
      if (cleared(value, p)) return { next: { state: "ok", pendingSince: null }, transition: "resolve" };
      return { next: prev, transition: null };
  }
}
