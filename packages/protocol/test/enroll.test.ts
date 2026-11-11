import { describe, expect, it } from "vitest";
import {
  EnrollRequestSchema,
  EnrollResponseSchema,
  RotateRequestSchema,
  DeviceInfoSchema,
} from "../src/index.js";

const uuid = "6c1f2b7e-3c55-4b7e-9f0a-1d2e3f4a5b6c";
const info = {
  hostname: "PC-01",
  os: "Windows 11 Pro 10.0.26300",
  agent_version: "0.1.0",
  gpus: [{ canonical_id: "GPU-8a1f", name: "NVIDIA GeForce RTX" }],
  adapters: [{ id: "if0", name: "Ethernet" }],
  volumes: [{ id: "C", name: "C:" }],
};

describe("enroll / rotate / device_info", () => {
  it("gecerli enroll istegi kabul edilir", () => {
    const r = EnrollRequestSchema.safeParse({
      token: "a".repeat(43), enroll_id: uuid, machine_guid: uuid, device_info: info,
    });
    expect(r.success).toBe(true);
  });
  it("enroll istegi bilinmeyen alani reddeder", () => {
    const r = EnrollRequestSchema.safeParse({
      token: "a".repeat(43), enroll_id: uuid, machine_guid: uuid, device_info: info, org_id: "x",
    });
    expect(r.success).toBe(false);
  });
  it("enroll yaniti device_id ve credential tasir", () => {
    const r = EnrollResponseSchema.safeParse({
      device_id: uuid, credential: "b".repeat(43), spki_pins: ["sha256/AAAA"],
    });
    expect(r.success).toBe(true);
  });
  it("rotate istegi rotation_id ister", () => {
    expect(RotateRequestSchema.safeParse({ rotation_id: uuid }).success).toBe(true);
    expect(RotateRequestSchema.safeParse({}).success).toBe(false);
  });
  it("device_info 17 GPU'yu reddeder (en fazla 16)", () => {
    const many = { ...info, gpus: Array.from({ length: 17 }, () => info.gpus[0]) };
    expect(DeviceInfoSchema.safeParse(many).success).toBe(false);
  });
});
