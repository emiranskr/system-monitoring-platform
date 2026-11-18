import { Info, WarningCircle, XCircle } from "@phosphor-icons/react";
import { cn } from "../../lib/cn";
import { SEVERITY_LABEL } from "../../lib/alerts";

const STYLE = {
  info: { cls: "text-status-unknown border-status-unknown", Icon: Info },
  warning: { cls: "text-status-warn border-status-warn", Icon: WarningCircle },
  critical: { cls: "text-status-crit border-status-crit", Icon: XCircle },
} as const;

/** Onem = ikon + metin + renk (renk TEK BASINA gosterge degildir). */
export function SeverityBadge({ severity, className }: { severity: keyof typeof SEVERITY_LABEL; className?: string }) {
  const { cls, Icon } = STYLE[severity];
  return (
    <span className={cn("inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-sm font-medium", cls, className)}>
      <Icon size={16} weight="fill" aria-hidden="true" />
      <span>{SEVERITY_LABEL[severity]}</span>
    </span>
  );
}
