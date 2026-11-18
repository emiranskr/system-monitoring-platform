import assert from "node:assert/strict";
import { test } from "node:test";
import { compareSnapshots } from "./drill-lib.mjs";

const snap = (over = {}) => ({ tables: { devices: 2, metric_samples: 500 }, hypertables: ["metric_samples"], caggs: ["metric_1m"], ...over });

test("ayni goruntu: basarili", () => {
  assert.deepEqual(compareSnapshots(snap(), snap()), { ok: true, problems: [] });
});
test("satir sayisi farki, eksik/fazla tablo, hypertable ve cagg farki BASARISIZ", () => {
  assert.equal(compareSnapshots(snap(), snap({ tables: { devices: 2, metric_samples: 499 } })).ok, false);
  assert.equal(compareSnapshots(snap(), snap({ tables: { devices: 2 } })).ok, false);
  assert.equal(compareSnapshots(snap(), snap({ tables: { devices: 2, metric_samples: 500, ekstra: 1 } })).ok, false);
  assert.equal(compareSnapshots(snap(), snap({ hypertables: [] })).ok, false);
  assert.equal(compareSnapshots(snap(), snap({ caggs: [] })).ok, false);
});
test("bos/gecersiz goruntu asla basarili sayilmaz (basarisiz geri yukleme basarili gorunmez)", () => {
  assert.equal(compareSnapshots(snap(), undefined).ok, false);
  assert.equal(compareSnapshots(snap(), {}).ok, false);
  assert.equal(compareSnapshots(undefined, snap()).ok, false);
  const empty = { tables: {}, hypertables: [], caggs: [] };
  assert.equal(compareSnapshots(empty, empty).ok, false);                       // bos == bos bile gecmez
  assert.equal(compareSnapshots(snap({ tables: { metric_samples: 0 } }), snap({ tables: { metric_samples: 0 } })).ok, false);   // bos kaynak anlamsiz
});
