import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { MeSchema } from "@sysmon/protocol";
import { ApiHttpError, ContractError, NetworkError, SessionExpiredError, apiFetch } from "./client";
import { mockFetch } from "../test/mockFetch";

afterEach(() => vi.unstubAllGlobals());

describe("apiFetch", () => {
  it("GET: sema ile dogrular, credentials same-origin gonderir", async () => {
    const { calls } = mockFetch({ "GET /api/v1/me": () => ({ status: 200, body: { email: "a@example.com", role: "admin" } }) });
    const me = await apiFetch("/api/v1/me", MeSchema);
    expect(me).toEqual({ email: "a@example.com", role: "admin" });
    expect(calls[0]!.init.credentials).toBe("same-origin");
  });

  it("POST: JSON govde + content-type", async () => {
    const { calls } = mockFetch({ "POST /api/v1/login": () => ({ status: 200, body: { user: { email: "a@example.com", role: "viewer" } } }) });
    await apiFetch("/api/v1/login", z.object({ user: MeSchema }), { method: "POST", json: { email: "a@example.com", password: "x" } });
    expect(calls[0]!.body).toEqual({ email: "a@example.com", password: "x" });
    expect((calls[0]!.init.headers as Record<string, string>)["content-type"]).toBe("application/json");
  });

  it("401 -> SessionExpiredError (giris ekranina yonlendirme sinyali)", async () => {
    mockFetch({ "GET /api/v1/me": () => ({ status: 401, body: { error: "unauthorized" } }) });
    await expect(apiFetch("/api/v1/me", MeSchema)).rejects.toBeInstanceOf(SessionExpiredError);
  });

  it("403/404/429 -> ApiHttpError(status, code); govde JSON degilse code 'unknown'", async () => {
    mockFetch({ "GET /api/v1/a": () => ({ status: 403, body: { error: "forbidden" } }), "GET /api/v1/b": () => ({ status: 404, body: { error: "not_found" } }), "GET /api/v1/c": () => ({ status: 429, body: { error: "rate_limited" } }) });
    await expect(apiFetch("/api/v1/a", MeSchema)).rejects.toMatchObject({ status: 403, code: "forbidden" });
    await expect(apiFetch("/api/v1/b", MeSchema)).rejects.toMatchObject({ status: 404, code: "not_found" });
    await expect(apiFetch("/api/v1/c", MeSchema)).rejects.toMatchObject({ status: 429, code: "rate_limited" });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>bad gateway</html>", { status: 502 })));
    const e = await apiFetch("/api/v1/d", MeSchema).catch((x) => x);
    expect(e).toBeInstanceOf(ApiHttpError);
    expect(e).toMatchObject({ status: 502, code: "unknown" });
  });

  it("SOZLESME ihlali (200 ama sema uymuyor) -> ContractError; undefined DONMEZ", async () => {
    mockFetch({ "GET /api/v1/me": () => ({ status: 200, body: { email: "a@example.com", role: "root", fazla: 1 } }) });
    const e = await apiFetch("/api/v1/me", MeSchema).catch((x) => x);
    expect(e).toBeInstanceOf(ContractError);
    expect((e as ContractError).path).toContain("role");
  });

  it("ag hatasi (fetch firlatir) -> NetworkError", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));
    await expect(apiFetch("/api/v1/me", MeSchema)).rejects.toBeInstanceOf(NetworkError);
  });

  it("204 govdesiz yanit: schema z.void() ile basarili", async () => {
    mockFetch({ "POST /api/v1/logout": () => ({ status: 204 }) });
    await expect(apiFetch("/api/v1/logout", z.void(), { method: "POST", json: {} })).resolves.toBeUndefined();
  });
});
