import { test } from "node:test";
import { strict as assert } from "node:assert";
import { evaluatePriming, type PrimingInput } from "../src/coach/priming.ts";

function input(over: Partial<PrimingInput> = {}): PrimingInput {
  return {
    minutesUntilReset: 240,
    fiveHourUsedPct: 70,
    snapshotStale: false,
    deepDurationMin: 120,
    primeIfUsedPct: 50,
    ...over,
  };
}

test("データ無し(usedPct null) → unknown", () => {
  const v = evaluatePriming(input({ fiveHourUsedPct: null }));
  assert.equal(v.action, "unknown");
  assert.equal(v.fiveHourUsedPct, null);
});

test("snapshot stale → unknown", () => {
  const v = evaluatePriming(input({ snapshotStale: true }));
  assert.equal(v.action, "unknown");
});

test("窓が期限切れ(reset<=0) → no_priming_needed（次の発話で新窓）", () => {
  const v = evaluatePriming(input({ minutesUntilReset: -5, fiveHourUsedPct: 90 }));
  assert.equal(v.action, "no_priming_needed");
  assert.ok(v.reason.includes("期限切れ") || v.reason.includes("新しい 5h 窓"));
});

test("reset ちょうど 0 も期限切れ扱い → no_priming_needed", () => {
  const v = evaluatePriming(input({ minutesUntilReset: 0, fiveHourUsedPct: 90 }));
  assert.equal(v.action, "no_priming_needed");
});

test("usedPct < 閾値（まだ新しい）→ no_priming_needed", () => {
  const v = evaluatePriming(input({ fiveHourUsedPct: 30 })); // < 50
  assert.equal(v.action, "no_priming_needed");
  assert.ok(v.reason.includes("十分新しい"));
});

test("境界: usedPct == 閾値 は「新しい」に含めない → wait_for_reset へ", () => {
  const v = evaluatePriming(input({ fiveHourUsedPct: 50, minutesUntilReset: 240, deepDurationMin: 120 }));
  assert.equal(v.action, "wait_for_reset");
});

test("reset がセッション内（自然リセット）→ no_priming_needed", () => {
  const v = evaluatePriming(input({ fiveHourUsedPct: 70, minutesUntilReset: 90, deepDurationMin: 120 }));
  assert.equal(v.action, "no_priming_needed");
  assert.ok(v.reason.includes("二重化") || v.reason.includes("途中"));
});

test("境界: reset == deepDuration はセッション内扱い（≤）→ no_priming_needed", () => {
  const v = evaluatePriming(input({ fiveHourUsedPct: 70, minutesUntilReset: 120, deepDurationMin: 120 }));
  assert.equal(v.action, "no_priming_needed");
});

test("消費進行 × セッション後リセット → wait_for_reset（アクティブ窓は前倒し不可）", () => {
  const v = evaluatePriming(input({ fiveHourUsedPct: 70, minutesUntilReset: 240, deepDurationMin: 120 }));
  assert.equal(v.action, "wait_for_reset");
  assert.ok(v.reason.includes("前倒し") || v.reason.includes("待つ"));
});

test("usedPct クランプ（>100/<0）でも妥当", () => {
  assert.equal(
    evaluatePriming(input({ fiveHourUsedPct: 150, minutesUntilReset: 240 })).action,
    "wait_for_reset",
  );
  assert.equal(evaluatePriming(input({ fiveHourUsedPct: -10 })).action, "no_priming_needed");
});

test("deepDurationMin 負値は 0 扱い（reset>0・消費進行なら wait_for_reset）", () => {
  const v = evaluatePriming(input({ deepDurationMin: -5, fiveHourUsedPct: 70, minutesUntilReset: 10 }));
  assert.equal(v.action, "wait_for_reset");
});

test("action と補助数値の整合（unknown は両 null）", () => {
  const u = evaluatePriming(input({ fiveHourUsedPct: null }));
  assert.equal(u.minutesUntilReset, null);
  assert.equal(u.fiveHourUsedPct, null);
});
