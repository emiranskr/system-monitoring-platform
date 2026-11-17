import { MagnifyingGlassMinus, MagnifyingGlassPlus } from "@phosphor-icons/react";
import { cn } from "../lib/cn";
import { RANGES, zoomRange, type RangeId } from "./range";

/**
 * Zaman araligi secici + Yakinlastir/Uzaklastir dugmeleri. Fircayla secim tek yol DEGILDIR: tum kontroller klavyeyle
 * erisilebilir, secili aralik `aria-pressed` ile bildirilir.
 */
export function RangePicker({ value, onChange }: { value: RangeId; onChange: (r: RangeId) => void }) {
  const btn = "inline-flex min-h-11 min-w-11 items-center justify-center gap-1 rounded-md border px-3 text-sm font-medium";
  return (
    <div role="group" aria-label="Zaman aralığı" className="flex flex-wrap items-center gap-2">
      {RANGES.map((r) => (
        <button
          key={r.id}
          type="button"
          aria-pressed={value === r.id}
          onClick={() => onChange(r.id)}
          className={cn(btn, value === r.id ? "border-accent bg-surface-2 text-accent" : "border-border bg-surface-1 text-text-secondary hover:text-text-primary")}
        >
          {r.label}
        </button>
      ))}
      <span className="mx-1 hidden h-6 w-px bg-border sm:block" aria-hidden="true" />
      <button type="button" onClick={() => onChange(zoomRange(value, "in"))} disabled={value === RANGES[0]!.id} className={cn(btn, "border-border bg-surface-1 disabled:opacity-50")}>
        <MagnifyingGlassPlus size={16} aria-hidden="true" /> Yakınlaştır
      </button>
      <button type="button" onClick={() => onChange(zoomRange(value, "out"))} disabled={value === RANGES[RANGES.length - 1]!.id} className={cn(btn, "border-border bg-surface-1 disabled:opacity-50")}>
        <MagnifyingGlassMinus size={16} aria-hidden="true" /> Uzaklaştır
      </button>
    </div>
  );
}
