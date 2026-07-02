import { test } from "node:test";
import { strict as assert } from "node:assert";
import { evaluatePriming } from "../src/coach/priming.ts";

test("Priming Case 1: Active window consumed + reset after deep → wait_for_reset", () => {
  const v = evaluatePriming({
    minutesUntilReset: 240,
    fiveHourUsedPct: 70,
    snapshotStale: false,
    deepDurationMin: 120,
    primeIfUsedPct: 50,
  });
  assert.equal(v.action, "wait_for_reset");
  assert.ok(v.reason.includes("前倒し") || v.reason.includes("待つ"));
});

test("Priming Case 2: Past reset (mur <= 0) → no_priming_needed", () => {
  const v = evaluatePriming({
    minutesUntilReset: -5,
    fiveHourUsedPct: 90,
    snapshotStale: false,
    deepDurationMin: 120,
    primeIfUsedPct: 50,
  });
  assert.equal(v.action, "no_priming_needed");
  assert.ok(v.reason.includes("新しい 5h 窓") || v.reason.includes("期限切れ"));
});

test("Priming Case 3: mur=0 (exactly at reset) → no_priming_needed", () => {
  const v = evaluatePriming({
    minutesUntilReset: 0,
    fiveHourUsedPct: 90,
    snapshotStale: false,
    deepDurationMin: 120,
    primeIfUsedPct: 50,
  });
  assert.equal(v.action, "no_priming_needed");
});

test("Priming Case 4: Still fresh (usedPct < threshold) → no_priming_needed", () => {
  const v = evaluatePriming({
    minutesUntilReset: 240,
    fiveHourUsedPct: 30,
    snapshotStale: false,
    deepDurationMin: 120,
    primeIfUsedPct: 50,
  });
  assert.equal(v.action, "no_priming_needed");
  assert.ok(v.reason.includes("十分新しい"));
});

test("Priming Case 5: Reset during deep (mur <= deepDuration) → no_priming_needed", () => {
  const v = evaluatePriming({
    minutesUntilReset: 90,
    fiveHourUsedPct: 70,
    snapshotStale: false,
    deepDurationMin: 120,
    primeIfUsedPct: 50,
  });
  assert.equal(v.action, "no_priming_needed");
  assert.ok(v.reason.includes("二重化") || v.reason.includes("途中"));
});

test("Priming Case 6: Boundary usedPct == threshold → wait_for_reset (not fresh)", () => {
  const v = evaluatePriming({
    minutesUntilReset: 240,
    fiveHourUsedPct: 50,
    snapshotStale: false,
    deepDurationMin: 120,
    primeIfUsedPct: 50,
  });
  assert.equal(v.action, "wait_for_reset");
});

test("Priming Case 7: Data missing (usedPct=null) → unknown", () => {
  const v = evaluatePriming({
    minutesUntilReset: 240,
    fiveHourUsedPct: null,
    snapshotStale: false,
    deepDurationMin: 120,
    primeIfUsedPct: 50,
  });
  assert.equal(v.action, "unknown");
  assert.equal(v.fiveHourUsedPct, null);
  assert.equal(v.minutesUntilReset, null);
});

test("Priming Case 8: Snapshot stale → unknown", () => {
  const v = evaluatePriming({
    minutesUntilReset: 240,
    fiveHourUsedPct: 70,
    snapshotStale: true,
    deepDurationMin: 120,
    primeIfUsedPct: 50,
  });
  assert.equal(v.action, "unknown");
});

test("Priming logic: No prime_now action (codex review correction)", () => {
  // Verify PrimingAction never returns "prime_now"
  for (const scenario of [
    { minutesUntilReset: 240, fiveHourUsedPct: 70, snapshotStale: false },
    { minutesUntilReset: 300, fiveHourUsedPct: 99, snapshotStale: false },
    { minutesUntilReset: 1, fiveHourUsedPct: 95, snapshotStale: false },
  ]) {
    const v = evaluatePriming({
      ...scenario,
      deepDurationMin: 120,
      primeIfUsedPct: 50,
    } as any);
    assert.notEqual(v.action, "prime_now", `Action should not be prime_now for ${JSON.stringify(scenario)}`);
  }
});
