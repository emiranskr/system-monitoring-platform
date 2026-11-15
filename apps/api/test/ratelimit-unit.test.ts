import { describe, expect, it } from "vitest";
import { RateLimiter, ipKey } from "../src/ratelimit.js";

const clock = { now: new Date("2026-11-12T12:00:00Z") };
const now = () => clock.now;

describe("ipKey (M-2: IPv6 /64)", () => {
  it("IPv4 aynen kalir", () => { expect(ipKey("203.0.113.7")).toBe("203.0.113.7"); });
  it("IPv4-eslemeli IPv6 IPv4 anahtarina iner", () => { expect(ipKey("::ffff:203.0.113.7")).toBe("203.0.113.7"); });
  it("ayni /64 icindeki farkli IPv6 adresleri AYNI anahtari verir", () => {
    expect(ipKey("2001:db8:1:2:aaaa:bbbb:cccc:dddd")).toBe(ipKey("2001:db8:1:2::1"));
    expect(ipKey("2001:db8:1:2::1")).toBe("2001:db8:1:2::/64");
  });
  it("farkli /64'ler farkli anahtar verir", () => {
    expect(ipKey("2001:db8:1:3::1")).not.toBe(ipKey("2001:db8:1:2::1"));
  });
  it("sikistirilmis ve buyuk/kucuk harf bicimleri esitlenir", () => {
    expect(ipKey("2001:DB8::1")).toBe("2001:db8:0:0::/64");
    expect(ipKey("::1")).toBe("0:0:0:0::/64");
  });
});

describe("RateLimiter bellek sinirlari (M-2)", () => {
  it("anahtar sayisi ust sinirda DURUR (bellek sinirsiz buyumez); sinirdayken yeni anahtar sayilmaz (fail-open)", () => {
    const l = new RateLimiter(1, 60_000, now, 100);
    for (let i = 0; i < 100; i++) expect(l.hit(`k${i}`)).toBe(true);
    expect(l.size).toBe(100);
    // 101. ve sonrasi: bellek buyumez, istek engellenmez.
    for (let i = 100; i < 1000; i++) expect(l.hit(`k${i}`)).toBe(true);
    expect(l.size).toBe(100);
  });

  it("sinirdaki mevcut anahtar hala sinirlanir", () => {
    const l = new RateLimiter(1, 60_000, now, 100);
    for (let i = 0; i < 100; i++) l.hit(`k${i}`);
    expect(l.hit("k0")).toBe(false);
  });

  it("pencere donunce eski anahtarlar temizlenir ve yenileri yeniden kabul edilir", () => {
    const l = new RateLimiter(1, 60_000, now, 100);
    for (let i = 0; i < 100; i++) l.hit(`k${i}`);
    clock.now = new Date(clock.now.getTime() + 61_000);
    try {
      expect(l.hit("yeni")).toBe(true);
      expect(l.size).toBe(1);
    } finally { clock.now = new Date("2026-11-12T12:00:00Z"); }
  });

  it("dolu tabloda her istekte O(n) tarama yapilmaz: pencere basina en fazla bir temizleme", () => {
    const l = new RateLimiter(1, 60_000, now, 100);
    for (let i = 0; i < 100; i++) l.hit(`k${i}`);
    for (let i = 0; i < 50; i++) l.hit(`x${i}`);
    expect(l.pruneCount).toBe(1);
  });
});
