import { z } from "zod";

/**
 * Uyari API sozlesmesi (M5). Metrik adi / operator / agg SABIT izin listesidir (kullanici girdisi SQL'e eklenmez; yalniz parametre).
 * Apps/api/src/alerts/{routes,evaluator,model}.ts ve panel ayni kaynagi kullanir.
 */
const IsoTime = z.iso.datetime();

export const ALERT_OPERATORS = [">", ">=", "<", "<="] as const;
export const ALERT_AGGS = ["avg", "max"] as const;
export const ALERT_SEVERITIES = ["info", "warning", "critical"] as const;
export const ALERT_BUILTINS = ["offline", "disk_full", "cpu_high", "mem_high"] as const;
/** Ozel metrik: cihazin sunucuya son ulasma zamanindan beri gecen saniye (sunucu alim zamani). */
export const OFFLINE_METRIC = "device.offline";

const SEG = "[A-Za-z0-9_\\-:]";
const ALERT_METRIC_PATTERNS: RegExp[] = [
  /^cpu\.total$/,
  /^mem\.used_pct$/,
  new RegExp(`^disk\\.(\\*|${SEG}{1,30})\\.used_pct$`),
  new RegExp(`^net\\.(\\*|${SEG}{1,40})\\.(rx_bps|tx_bps)$`),
  new RegExp(`^gpu\\.(\\*|[A-Za-z0-9\\-:]{1,44})\\.(util_pct|temp_c|vram_used_bytes|power_w|fan_pct|core_clock_mhz|mem_clock_mhz)$`),
  /^sensor\.(cpu_package_temp_c|cpu_core_max_temp_c|motherboard_temp_c|cpu_fan_rpm)$/,
  /^device\.offline$/,
];
export function isAllowedAlertMetric(m: unknown): m is string {
  return typeof m === "string" && m.length <= 64 && ALERT_METRIC_PATTERNS.some((re) => re.test(m));
}

const AlertMetricSchema = z.string().max(64).refine(isAllowedAlertMetric, { message: "izin listesinde olmayan metrik" });
const Name = z.string().trim().min(1).max(100);

/** Alanlar (varsayilansiz): olusturma bunlara varsayilan ekler; kismi guncelleme VARSAYILAN UYGULAMAZ (aksi halde PATCH sessizce alanlari sifirlardi). */
const ruleFields = {
  name: Name,
  metric: AlertMetricSchema,
  agg: z.enum(ALERT_AGGS),
  window_seconds: z.number().int().min(15).max(3600),
  operator: z.enum(ALERT_OPERATORS),
  threshold: z.number().finite(),
  hysteresis: z.number().finite().min(0),
  for_seconds: z.number().int().min(0).max(86400),
  severity: z.enum(ALERT_SEVERITIES),
  scope_device_ids: z.array(z.uuid()).max(200).nullable(),
  channel_ids: z.array(z.uuid()).max(20),
  enabled: z.boolean(),
};

export const AlertRuleInputSchema = z.strictObject({
  ...ruleFields,
  hysteresis: ruleFields.hysteresis.default(0),
  scope_device_ids: ruleFields.scope_device_ids.default(null),
  channel_ids: ruleFields.channel_ids.default([]),
  enabled: ruleFields.enabled.default(true),
});
export type AlertRuleInput = z.infer<typeof AlertRuleInputSchema>;

/** Kismi guncelleme: en az bir alan. Yerlesik kurallarda metrik/ad degismez (sunucu zorlar). */
export const AlertRulePatchSchema = z.strictObject(ruleFields).partial().refine((o) => Object.keys(o).length > 0, { message: "en az bir alan" });
export type AlertRulePatch = z.infer<typeof AlertRulePatchSchema>;

export const AlertRuleSchema = z.strictObject({
  id: z.uuid(),
  name: z.string(),
  metric: z.string(),
  agg: z.enum(ALERT_AGGS),
  window_seconds: z.number().int(),
  operator: z.enum(ALERT_OPERATORS),
  threshold: z.number(),
  hysteresis: z.number(),
  for_seconds: z.number().int(),
  severity: z.enum(ALERT_SEVERITIES),
  scope_device_ids: z.array(z.uuid()).nullable(),
  channel_ids: z.array(z.uuid()),
  builtin: z.enum(ALERT_BUILTINS).nullable(),
  enabled: z.boolean(),
  created_at: IsoTime,
  updated_at: IsoTime,
});
export type AlertRule = z.infer<typeof AlertRuleSchema>;
export const AlertRulesResponseSchema = z.strictObject({ rules: z.array(AlertRuleSchema) });

export const WebhookChannelInputSchema = z.strictObject({
  type: z.literal("webhook"),
  name: Name,
  url: z.string().min(8).max(2048),
  secret: z.string().min(1).max(256).optional(),
});
export const EmailChannelInputSchema = z.strictObject({
  type: z.literal("email"),
  name: Name,
  host: z.string().min(1).max(253),
  port: z.number().int().min(1).max(65535),
  secure: z.boolean().default(false),
  user: z.string().min(1).max(256).optional(),
  pass: z.string().min(1).max(256).optional(),
  from: z.string().min(3).max(254),
  to: z.array(z.string().min(3).max(254)).min(1).max(10),
});
export const ChannelInputSchema = z.discriminatedUnion("type", [WebhookChannelInputSchema, EmailChannelInputSchema]);
export type ChannelInput = z.infer<typeof ChannelInputSchema>;

/** API'ye SIR ICERMEYEN ozet doner (webhook: yalniz ana makine; e-posta: sunucu, port, alici sayisi). */
export const ChannelSummarySchema = z.union([
  z.strictObject({ host: z.string() }),
  z.strictObject({ host: z.string(), port: z.number().int(), recipients: z.number().int() }),
]);
export const NotificationChannelSchema = z.strictObject({
  id: z.uuid(),
  name: z.string(),
  type: z.enum(["webhook", "email"]),
  summary: ChannelSummarySchema,
  created_at: IsoTime,
});
export type NotificationChannel = z.infer<typeof NotificationChannelSchema>;
export const NotificationChannelsResponseSchema = z.strictObject({ channels: z.array(NotificationChannelSchema) });

export const IncidentSchema = z.strictObject({
  id: z.uuid(),
  rule_id: z.uuid(),
  rule_name: z.string(),
  device_id: z.uuid(),
  device_name: z.string(),
  metric: z.string(),
  severity: z.enum(ALERT_SEVERITIES),
  opened_at: IsoTime,
  resolved_at: IsoTime.nullable(),
  last_value: z.number().nullable(),
  peak_value: z.number().nullable(),
});
export type Incident = z.infer<typeof IncidentSchema>;
export const IncidentsResponseSchema = z.strictObject({ incidents: z.array(IncidentSchema) });
export const IncidentsQuerySchema = z.strictObject({
  state: z.enum(["open", "resolved", "all"]).default("all"),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const ChannelTestResponseSchema = z.strictObject({ queued: z.literal(true) });
