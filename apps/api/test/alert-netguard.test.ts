import { describe, expect, it } from "vitest";
import { isBlockedIp, resolveSafe, SsrfError } from "../src/alerts/net-guard.js";

describe("SSRF: engellenen IP araliklari", () => {
  it.each([
    "0.0.0.0", "0.1.2.3", "10.0.0.1", "10.255.255.255", "100.64.0.1", "100.127.255.255", "127.0.0.1", "127.255.255.254", "169.254.169.254",
    "172.16.0.1", "172.31.255.255", "192.0.0.1", "192.0.2.5", "192.168.1.1", "198.18.0.1", "198.19.255.255", "198.51.100.1", "203.0.113.9",
    "224.0.0.1", "239.255.255.255", "240.0.0.1", "255.255.255.255",
  ])("IPv4 %s engellenir", (ip) => { expect(isBlockedIp(ip)).toBe(true); });

  it.each(["1.1.1.1", "8.8.8.8", "93.184.216.34", "172.15.255.255", "172.32.0.1", "100.63.255.255", "100.128.0.1", "198.17.255.255", "198.20.0.1", "11.0.0.1", "169.253.1.1"])(
    "genel IPv4 %s engellenmez", (ip) => { expect(isBlockedIp(ip)).toBe(false); });

  it.each([
    "::", "::1", "fe80::1", "febf::1", "fc00::1", "fd12:3456::1", "ff02::1", "2001:db8::1", "2001::1", "100::1", "fec0::1",
    "::ffff:127.0.0.1", "::ffff:10.0.0.1", "::ffff:7f00:1", "0:0:0:0:0:ffff:a00:1", "::ffff:169.254.169.254", "64:ff9b::7f00:1", "64:ff9b::a00:1", "2002:7f00:1::1",
  ])("IPv6 %s engellenir", (ip) => { expect(isBlockedIp(ip)).toBe(true); });

  it.each(["2606:4700:4700::1111", "2001:4860:4860::8888", "::ffff:8.8.8.8", "64:ff9b::808:808"])("genel IPv6 %s engellenmez", (ip) => {
    expect(isBlockedIp(ip)).toBe(false);
  });

  it("gecersiz metin guvenli tarafta: engellenir", () => {
    for (const bad of ["", "abc", "999.1.1.1", "1.2.3", "::g"]) expect(isBlockedIp(bad)).toBe(true);
  });
});

describe("resolveSafe: cozumleme + dogrulama TEK adimda", () => {
  const lookupTo = (...addrs: string[]) => async () => addrs.map((a) => ({ address: a, family: a.includes(":") ? 6 : 4 }));

  it("genel adres doner", async () => {
    expect(await resolveSafe("hooks.example.com", { allowPrivate: false, lookup: lookupTo("93.184.216.34") })).toEqual({ address: "93.184.216.34", family: 4 });
  });

  it("ozel/loopback/link-local'e cozumlenen ad reddedilir (SsrfError)", async () => {
    for (const a of ["127.0.0.1", "10.1.2.3", "169.254.169.254", "::1", "fd00::1", "::ffff:192.168.0.1"])
      await expect(resolveSafe("evil.example.com", { allowPrivate: false, lookup: lookupTo(a) })).rejects.toBeInstanceOf(SsrfError);
  });

  it("DNS REBINDING: bir adres genel digeri ozel ise TUMU reddedilir", async () => {
    await expect(resolveSafe("rebind.example.com", { allowPrivate: false, lookup: lookupTo("93.184.216.34", "127.0.0.1") })).rejects.toBeInstanceOf(SsrfError);
  });

  it("IP literal ana makine dogrudan denetlenir (cozumleme yok); koseli IPv6 literal", async () => {
    await expect(resolveSafe("127.0.0.1", { allowPrivate: false })).rejects.toBeInstanceOf(SsrfError);
    await expect(resolveSafe("[::1]", { allowPrivate: false })).rejects.toBeInstanceOf(SsrfError);
    await expect(resolveSafe("169.254.169.254", { allowPrivate: false })).rejects.toBeInstanceOf(SsrfError);
    expect((await resolveSafe("8.8.8.8", { allowPrivate: false })).address).toBe("8.8.8.8");
  });

  it("localhost ve cozumlenemeyen ad reddedilir", async () => {
    await expect(resolveSafe("localhost", { allowPrivate: false, lookup: lookupTo("127.0.0.1") })).rejects.toBeInstanceOf(SsrfError);
    await expect(resolveSafe("yok.example.com", { allowPrivate: false, lookup: async () => { throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" }); } })).rejects.toBeInstanceOf(SsrfError);
    await expect(resolveSafe("bos.example.com", { allowPrivate: false, lookup: async () => [] })).rejects.toBeInstanceOf(SsrfError);
  });

  it("allowPrivate (YALNIZ gelistirme/test bayragi) ozel adrese izin verir", async () => {
    expect((await resolveSafe("127.0.0.1", { allowPrivate: true })).address).toBe("127.0.0.1");
    expect((await resolveSafe("dev.local", { allowPrivate: true, lookup: lookupTo("10.0.0.5") })).address).toBe("10.0.0.5");
  });
});
