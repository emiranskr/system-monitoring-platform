import { test } from "node:test";
import assert from "node:assert/strict";
import { isAllowed } from "./license-policy.mjs";

test("MIT izinli", () => assert.equal(isAllowed("MIT"), true));
test("Apache-2.0 izinli", () => assert.equal(isAllowed("Apache-2.0"), true));
test("GPL-3.0 reddedilir", () => assert.equal(isAllowed("GPL-3.0-only"), false));
test("AGPL reddedilir", () => assert.equal(isAllowed("AGPL-3.0-or-later"), false));
test("SSPL reddedilir", () => assert.equal(isAllowed("SSPL-1.0"), false));
test("bilinmeyen reddedilir", () => assert.equal(isAllowed("UNKNOWN"), false));
test("bos reddedilir", () => assert.equal(isAllowed(""), false));
test("OR ifadesinde izinli alternatif yeterli", () =>
  assert.equal(isAllowed("(MIT OR GPL-3.0-only)"), true));
test("AND ifadesinde biri reddedilirse tumu reddedilir", () =>
  assert.equal(isAllowed("(MIT AND GPL-3.0-only)"), false));
test("MPL-2.0 izinli (dosya duzeyi copyleft)", () => assert.equal(isAllowed("MPL-2.0"), true));
