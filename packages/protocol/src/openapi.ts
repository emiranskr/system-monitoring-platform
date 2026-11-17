import { z } from "zod";
import {
  ApiErrorSchema, DeviceDetailSchema, DeviceSummarySchema, DevicesResponseSchema, EnrollmentTokenRequestSchema, EnrollmentTokenResponseSchema,
  LoginRequestSchema, LoginResponseSchema, MeSchema, MetricNamesResponseSchema, MetricSeriesSchema, SampleEventPayloadSchema,
} from "./api.js";

const schemas = {
  DeviceSummary: DeviceSummarySchema, DevicesResponse: DevicesResponseSchema, DeviceDetail: DeviceDetailSchema, MetricSeries: MetricSeriesSchema,
  MetricNamesResponse: MetricNamesResponseSchema, Me: MeSchema, LoginRequest: LoginRequestSchema, LoginResponse: LoginResponseSchema,
  EnrollmentTokenRequest: EnrollmentTokenRequestSchema, EnrollmentTokenResponse: EnrollmentTokenResponseSchema, SampleEventPayload: SampleEventPayloadSchema,
  ApiError: ApiErrorSchema,
} as const;

const ref = (n: keyof typeof schemas) => ({ $ref: `#/components/schemas/${n}` });
const json = (n: keyof typeof schemas) => ({ "application/json": { schema: ref(n) } });
const err = (description: string) => ({ description, content: json("ApiError") });
const idParam = { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } };

/**
 * OpenAPI 3.1 belgesi, panel API sozlesmesinden (zod -> JSON Schema) uretilir. Oturum cerezi (`__Host-sid`) + durum degistiren
 * isteklerde izinli `Origin` basligi sartlari her yolda gecerlidir. Dosyaya yazmak icin: `pnpm --filter @sysmon/protocol gen:openapi`.
 */
export function buildOpenApi(): object {
  const components: Record<string, unknown> = {};
  for (const [name, s] of Object.entries(schemas)) components[name] = z.toJSONSchema(s, { target: "draft-2020-12", io: "output" });
  const unauth = { "401": err("Oturum yok/gecersiz/suresi dolmus"), "403": err("Yetersiz rol veya izinsiz Origin") };
  return {
    openapi: "3.1.0",
    info: { title: "System Monitoring Platform — Panel API", version: "1.0.0", description: "Oturum cerezi (__Host-sid) ile korunur. Durum degistiren isteklerde Origin izinli listede olmalidir. Baska organizasyonun veya olmayan kaynaklar ayni 404'u dondurur." },
    components: {
      securitySchemes: { sessionCookie: { type: "apiKey", in: "cookie", name: "__Host-sid" } },
      schemas: components,
    },
    security: [{ sessionCookie: [] }],
    paths: {
      "/api/v1/login": { post: { security: [], summary: "Giris", requestBody: { required: true, content: json("LoginRequest") }, responses: { "200": { description: "Giris basarili (oturum cerezi set edilir)", content: json("LoginResponse") }, "401": err("Gecersiz kimlik bilgisi (tekduze)"), "429": err("Hiz siniri") } } },
      "/api/v1/logout": { post: { summary: "Cikis", responses: { "204": { description: "Oturum iptal edildi" }, ...unauth } } },
      "/api/v1/me": { get: { summary: "Gecerli kullanici (ayni zamanda oturumu canli tutar)", responses: { "200": { description: "Kullanici", content: json("Me") }, ...unauth } } },
      "/api/v1/devices": { get: { summary: "Filo listesi", responses: { "200": { description: "Cihazlar", content: json("DevicesResponse") }, ...unauth } } },
      "/api/v1/devices/{id}": { get: { summary: "Cihaz detayi", parameters: [idParam], responses: { "200": { description: "Cihaz", content: json("DeviceDetail") }, ...unauth, "404": err("Bulunamadi (baska org ile ayni)") } } },
      "/api/v1/devices/{id}/metrics": { get: { summary: "Metrik gecmisi", parameters: [idParam,
        { name: "metric", in: "query", required: true, schema: { type: "string" } }, { name: "from", in: "query", required: true, schema: { type: "string", format: "date-time" } },
        { name: "to", in: "query", required: true, schema: { type: "string", format: "date-time" } }, { name: "max_points", in: "query", required: false, schema: { type: "integer", minimum: 10, maximum: 1500 } }],
        responses: { "200": { description: "Seri (bos aralik: points=[])", content: json("MetricSeries") }, "400": err("Gecersiz parametre"), ...unauth, "404": err("Bulunamadi") } } },
      "/api/v1/devices/{id}/metric-names": { get: { summary: "Son 10 dk'da veri gelen metrik adlari (ada gore sirali, en cok 200)", parameters: [idParam], responses: { "200": { description: "Metrik adlari (bos liste gecerli)", content: json("MetricNamesResponse") }, ...unauth, "404": err("Bulunamadi") } } },
      "/api/v1/enrollment-tokens": { post: { summary: "Cihaz kaydi icin tek kullanimlik token (admin|owner)", requestBody: { required: true, content: json("EnrollmentTokenRequest") }, responses: { "201": { description: "Token (yalniz bu yanitta)", content: json("EnrollmentTokenResponse") }, "400": err("Gecersiz govde"), ...unauth, "429": err("Hiz siniri") } } },
      "/api/v1/stream": { get: { summary: "Canli akis (Server-Sent Events): `ready`, `sample` (SampleEventPayload), `closed` olaylari", parameters: [{ name: "devices", in: "query", required: false, schema: { type: "string", description: "Virgulle ayrilmis cihaz kimlikleri (en cok 50)" } }], responses: { "200": { description: "text/event-stream; `sample` olaylarinin data govdesi SampleEventPayload'dir", content: { "text/event-stream": { schema: { type: "string" } } } }, ...unauth, "404": err("Cihaz bulunamadi"), "429": err("Kullanici basina en cok 3 akis") } } },
    },
  };
}
