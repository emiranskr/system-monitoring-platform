import { z } from "zod";

const Ident = z.string().min(1).max(64);
const Named = z.strictObject({ id: Ident, name: z.string().min(1).max(128) });

export const DeviceInfoSchema = z.strictObject({
  hostname: z.string().min(1).max(255),
  os: z.string().min(1).max(128),
  agent_version: z.string().min(1).max(32),
  gpus: z.array(z.strictObject({ canonical_id: Ident, name: z.string().min(1).max(128) })).max(16),
  adapters: z.array(Named).max(64),
  volumes: z.array(Named).max(64),
});
export type DeviceInfo = z.infer<typeof DeviceInfoSchema>;

export const EnrollRequestSchema = z.strictObject({
  token: z.string().min(32).max(128),
  enroll_id: z.uuid(),
  machine_guid: z.string().min(1).max(64),
  device_info: DeviceInfoSchema,
});
export type EnrollRequest = z.infer<typeof EnrollRequestSchema>;

export const EnrollResponseSchema = z.strictObject({
  device_id: z.uuid(),
  credential: z.string().min(32).max(128),
  /** Enrollment paketindeki SPKI parmak izlerinin yankisi (agent sabitler). */
  spki_pins: z.array(z.string()).max(4),
});
export type EnrollResponse = z.infer<typeof EnrollResponseSchema>;

export const RotateRequestSchema = z.strictObject({ rotation_id: z.uuid() });
export type RotateRequest = z.infer<typeof RotateRequestSchema>;

export const RotateResponseSchema = z.strictObject({
  credential: z.string().min(32).max(128),
  overlap_expires_at: z.iso.datetime(),
});
export type RotateResponse = z.infer<typeof RotateResponseSchema>;

export const CollectorStatusSchema = z.strictObject({
  name: Ident,
  ok: z.boolean(),
  message: z.string().max(256).optional(),
});
export type CollectorStatus = z.infer<typeof CollectorStatusSchema>;
