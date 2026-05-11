import { test } from "node:test";
import { strict as assert } from "node:assert";
import { DeepWorkAccumulator } from "../src/infer/work_state.ts";

test("DeepWorkAccumulator: バケット別に分配する", () => {
  const acc = new DeepWorkAccumulator();
  const t0 = new Date("2026-05-09T01:00:00Z");
  const t1 = new Date("2026-05-09T01:05:00Z"); // +5 min manual
  const t2 = new Date("2026-05-09T01:15:00Z"); // +10 min auto
  const t3 = new Date("2026-05-09T01:18:00Z"); // +3 min bypass
  const t4 = new Date("2026-05-09T01:25:00Z"); // +7 min idle (no contribution)

  acc.feed("active", t0, "manual");
  acc.feed("active", t1, "auto");   // 5 min を manual に積む
  acc.feed("ai_busy", t2, "bypass"); // 10 min を auto に積む
  acc.feed("idle", t3, "manual");    // 3 min を bypass に積む
  acc.feed("idle", t4, "manual");    // idle なので何もしない

  const bd = acc.todayBreakdown(t4);
  assert.equal(bd.manual, 5);
  assert.equal(bd.auto, 10);
  assert.equal(bd.bypass, 3);
  assert.equal(bd.total, 18);
});

test("DeepWorkAccumulator: 旧 byDate のみ → manual に寄せる", () => {
  const acc = new DeepWorkAccumulator();
  acc.loadFromJSON({
    byDate: {
      "2026-05-08": 60 * 60_000,
    },
  });
  const ref = new Date("2026-05-08T12:00:00Z");
  const bd = acc.todayBreakdown(ref);
  assert.equal(bd.manual, 60);
  assert.equal(bd.auto, 0);
  assert.equal(bd.bypass, 0);
});

test("DeepWorkAccumulator: byDateBuckets を優先し round-trip 一致", () => {
  const acc = new DeepWorkAccumulator();
  acc.loadFromJSON({
    byDate: { "2026-05-09": 16 * 60_000 },
    byDateBuckets: {
      "2026-05-09": { manual: 12 * 60_000, auto: 3 * 60_000, bypass: 1 * 60_000 },
    },
  });
  const out = acc.toJSON();
  // toJSON は両フィールド書き出し
  assert.equal(out.byDate["2026-05-09"], 16 * 60_000);
  assert.ok(out.byDateBuckets);
  const day = out.byDateBuckets!["2026-05-09"];
  assert.equal(day!.manual, 12 * 60_000);
  assert.equal(day!.auto, 3 * 60_000);
  assert.equal(day!.bypass, 1 * 60_000);
});

test("DeepWorkAccumulator: 初回 feed では加算しない（lastCheckAt が無い）", () => {
  const acc = new DeepWorkAccumulator();
  const t0 = new Date("2026-05-09T01:00:00Z");
  acc.feed("active", t0, "manual");
  const bd = acc.todayBreakdown(t0);
  assert.equal(bd.total, 0);
});
