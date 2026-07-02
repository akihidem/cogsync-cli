import { test } from "node:test";
import { strict as assert } from "node:assert";
import { evaluateReserveGate, type ReserveGateInput } from "../src/coach/reserve.ts";

function input(over: Partial<ReserveGateInput> = {}): ReserveGateInput {
  return {
    fiveHourUsedPct: 40,
    snapshotStale: false,
    weeklyLevel: "green",
    weeklyStale: false,
    reservePhi: 0.3,
    onUnknown: "allow",
    ...over,
  };
}

// ─── 週次 red（最優先・確定 hold） ───────────────────────────────────────────

test("週次 red(fresh) → hold（5h に余裕があっても onUnknown に関係なく）", () => {
  const v = evaluateReserveGate(input({ weeklyLevel: "red", fiveHourUsedPct: 10 }));
  assert.equal(v.allow, false);
  assert.equal(v.verdict, "hold");
  assert.deepEqual(v.blockedBy, ["weekly_red"]);
});

test("週次 red だが stale → red 無視（5h 判定に進む）", () => {
  const v = evaluateReserveGate(input({ weeklyLevel: "red", weeklyStale: true, fiveHourUsedPct: 10 }));
  assert.equal(v.allow, true);
  assert.equal(v.verdict, "allow");
});

test("週次 red かつ 5h も測れない → weekly_red で hold（onUnknown より優先）", () => {
  const v = evaluateReserveGate(
    input({ weeklyLevel: "red", fiveHourUsedPct: null, onUnknown: "allow" }),
  );
  assert.equal(v.allow, false);
  assert.deepEqual(v.blockedBy, ["weekly_red"]);
});

// ─── 5h リザーブ ─────────────────────────────────────────────────────────────

test("5h 残 60% ≥ φ 30% → allow", () => {
  const v = evaluateReserveGate(input({ fiveHourUsedPct: 40 }));
  assert.equal(v.allow, true);
  assert.equal(v.verdict, "allow");
  assert.equal(v.fiveHourRemainingPct, 60);
  assert.deepEqual(v.blockedBy, []);
});

test("5h 残 20% < φ 30% → hold（five_hour_reserve）", () => {
  const v = evaluateReserveGate(input({ fiveHourUsedPct: 80 }));
  assert.equal(v.allow, false);
  assert.equal(v.verdict, "hold");
  assert.deepEqual(v.blockedBy, ["five_hour_reserve"]);
});

test("境界: 残 == φ ちょうどは allow（< で hold）", () => {
  const v = evaluateReserveGate(input({ fiveHourUsedPct: 70, reservePhi: 0.3 })); // 残 30% == 30%
  assert.equal(v.allow, true);
});

test("境界の直下: 残 29.9% < φ 30% は hold", () => {
  const v = evaluateReserveGate(input({ fiveHourUsedPct: 70.1, reservePhi: 0.3 }));
  assert.equal(v.allow, false);
});

// ─── estimatedUsagePct ───────────────────────────────────────────────────────

test("estimatedUsagePct を引いて φ を割る → hold", () => {
  // 残 50% − 見込み 30pt = 20% < φ 30%
  const v = evaluateReserveGate(input({ fiveHourUsedPct: 50, estimatedUsagePct: 30 }));
  assert.equal(v.allow, false);
  assert.deepEqual(v.blockedBy, ["five_hour_reserve"]);
});

test("estimatedUsagePct を引いても余る → allow", () => {
  // 残 90% − 見込み 30pt = 60% ≥ φ 30%
  const v = evaluateReserveGate(input({ fiveHourUsedPct: 10, estimatedUsagePct: 30 }));
  assert.equal(v.allow, true);
});

test("estimatedUsagePct 負値は 0 扱い", () => {
  const v = evaluateReserveGate(input({ fiveHourUsedPct: 40, estimatedUsagePct: -50 }));
  assert.equal(v.allow, true);
  assert.equal(v.fiveHourRemainingPct, 60);
});

test("estimatedUsagePct >100 は 100 にクランプ（純関数の防御）", () => {
  // 残 100% − クランプ後 100pt = 0% < φ 30% → hold（NaN や型外でも妥当な判定）
  const v = evaluateReserveGate(input({ fiveHourUsedPct: 0, estimatedUsagePct: 500 }));
  assert.equal(v.allow, false);
  assert.deepEqual(v.blockedBy, ["five_hour_reserve"]);
  const v2 = evaluateReserveGate(input({ fiveHourUsedPct: 0, estimatedUsagePct: Number.NaN }));
  assert.equal(v2.allow, true); // NaN → 0 扱い、残 100% ≥ φ
});

// ─── unknown（5h が測れない） ────────────────────────────────────────────────

test("usedPct=null・onUnknown=allow → unknown/allow", () => {
  const v = evaluateReserveGate(input({ fiveHourUsedPct: null, weeklyLevel: null }));
  assert.equal(v.verdict, "unknown");
  assert.equal(v.allow, true);
  assert.equal(v.fiveHourRemainingPct, null);
});

test("usedPct=null・onUnknown=deny → unknown/hold(allow=false)", () => {
  const v = evaluateReserveGate(input({ fiveHourUsedPct: null, weeklyLevel: null, onUnknown: "deny" }));
  assert.equal(v.verdict, "unknown");
  assert.equal(v.allow, false);
});

test("snapshot stale → unknown（usedPct が数値でも測れない扱い）", () => {
  const v = evaluateReserveGate(input({ fiveHourUsedPct: 40, snapshotStale: true, weeklyLevel: null }));
  assert.equal(v.verdict, "unknown");
  assert.equal(v.allow, true);
});

// ─── クランプ（防御） ────────────────────────────────────────────────────────

test("reservePhi>1 でも例外なく妥当（1 にクランプ→ほぼ常に hold）", () => {
  const v = evaluateReserveGate(input({ fiveHourUsedPct: 0, reservePhi: 5 }));
  assert.equal(v.reservePct, 100);
  assert.equal(v.allow, true); // 残 100% ≥ 100%
  const v2 = evaluateReserveGate(input({ fiveHourUsedPct: 1, reservePhi: 5 }));
  assert.equal(v2.allow, false); // 残 99% < 100%
});

test("reservePhi<0 は 0 にクランプ（常に allow 方向）", () => {
  const v = evaluateReserveGate(input({ fiveHourUsedPct: 99, reservePhi: -1 }));
  assert.equal(v.reservePct, 0);
  assert.equal(v.allow, true);
});

test("usedPct>100 / <0 でもクランプして妥当", () => {
  assert.equal(evaluateReserveGate(input({ fiveHourUsedPct: 150 })).allow, false); // 残 0
  assert.equal(evaluateReserveGate(input({ fiveHourUsedPct: -20 })).allow, true); // 残 100
});

// ─── allow と blockedBy の整合 ──────────────────────────────────────────────

test("allow=true なら blockedBy 空・verdict=allow", () => {
  for (const used of [0, 20, 40, 69]) {
    const v = evaluateReserveGate(input({ fiveHourUsedPct: used }));
    if (v.allow) {
      assert.equal(v.verdict, "allow");
      assert.deepEqual(v.blockedBy, []);
    }
  }
});

test("allow=false なら verdict は hold か unknown", () => {
  const holds = [
    evaluateReserveGate(input({ weeklyLevel: "red" })),
    evaluateReserveGate(input({ fiveHourUsedPct: 90 })),
    evaluateReserveGate(input({ fiveHourUsedPct: null, onUnknown: "deny", weeklyLevel: null })),
  ];
  for (const v of holds) {
    assert.equal(v.allow, false);
    assert.ok(v.verdict === "hold" || v.verdict === "unknown");
  }
});
