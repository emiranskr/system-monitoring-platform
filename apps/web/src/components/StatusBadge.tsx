import { CheckCircle, CloudSlash, Prohibit, Question, WarningCircle } from "@phosphor-icons/react";
import type { DeviceStatus } from "@sysmon/protocol";
import { cn } from "../lib/cn";
import { STATUS_LABEL } from "../lib/fleet";

const STYLE: Record<DeviceStatus, { cls: string; Icon: typeof CheckCircle }> = {
  online: { cls: "text-status-ok border-status-ok", Icon: CheckCircle },
  stale: { cls: "text-status-warn border-status-warn", Icon: WarningCircle },
  offline: { cls: "text-status-offline border-status-offline", Icon: CloudSlash },
  unknown: { cls: "text-status-unknown border-status-unknown", Icon: Question },
  revoked: { cls: "text-status-crit border-status-crit", Icon: Prohibit },
};

/** Durum = ikon + metin + renk (renk TEK BASINA gosterge degildir). Ikon dekoratif (aria-hidden), anlam metindedir. */
export function StatusBadge({ status, className }: { status: DeviceStatus; className?: string }) {
  const { cls, Icon } = STYLE[status];
  return (
    <span className={cn("inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-sm font-medium", cls, className)}>
      <Icon size={16} weight="fill" aria-hidden="true" />
      <span>{STATUS_LABEL[status]}</span>
    </span>
  );
}
