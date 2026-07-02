import { test } from "node:test";
import { strict as assert } from "node:assert";
import { evaluateHandoffThreshold } from "../src/coach/handoff_rule.ts";

test("Case 1: wait=100 > handoff=25 → handoff", () => {
  const v = evaluateHandoffThreshold({
    minutesUntilReset: 100,
    taskValue: 50,
    secondaryQuality: 0.9,
    handoffCost: 20,
    delayCostPerMin: 1.0,
  });
  assert.equal(v.recommend, "handoff");
  assert.equal(v.waitCost, 100);
  assert.equal(v.handoffTotalCost, 25);
});

test("Case 2: wait=20 < handoff=25 → wait", () => {
  const v = evaluateHandoffThreshold({
    minutesUntilReset: 20,
    taskValue: 50,
    secondaryQuality: 0.9,
    handoffCost: 20,
    delayCostPerMin: 1.0,
  });
  assert.equal(v.recommend, "wait");
  assert.equal(v.waitCost, 20);
  assert.equal(v.handoffTotalCost, 25);
});

test("Case 3: wait=25 == handoff=25 → wait (conservative)", () => {
  const v = evaluateHandoffThreshold({
    minutesUntilReset: 25,
    taskValue: 50,
    secondaryQuality: 0.9,
    handoffCost: 20,
    delayCostPerMin: 1.0,
  });
  assert.equal(v.recommend, "wait");
});

test("Case 4: τ=0 (past reset) → wait", () => {
  const v = evaluateHandoffThreshold({
    minutesUntilReset: 0,
    taskValue: 50,
    secondaryQuality: 0.9,
    handoffCost: 20,
    delayCostPerMin: 1.0,
  });
  assert.equal(v.recommend, "wait");
  assert.equal(v.waitCost, 0);
});

test("Case 5: q'=1 (same quality) → handoffCost=h only", () => {
  const v = evaluateHandoffThreshold({
    minutesUntilReset: 100,
    taskValue: 100,
    secondaryQuality: 1.0,
    handoffCost: 20,
    delayCostPerMin: 1.0,
  });
  assert.equal(v.recommend, "handoff");
  assert.equal(v.handoffTotalCost, 20);
});

test("Case 6: All negatives clamp to 0 → wait", () => {
  const v = evaluateHandoffThreshold({
    minutesUntilReset: 50,
    taskValue: -100,
    secondaryQuality: -0.5,
    handoffCost: -10,
    delayCostPerMin: -2.0,
  });
  assert.equal(v.recommend, "wait");
  assert.equal(v.handoffTotalCost, 0);
  assert.equal(v.waitCost, 0);
});

test("Mathematical formula verification: c_d·τ > h+(1−q')·v", () => {
  // 例: c_d=1, τ=100, h=20, q'=0.9, v=50
  // wait = 1·100=100, handoff = 20+0.1·50=25
  // 100 > 25 → handoff ✓
  const v = evaluateHandoffThreshold({
    minutesUntilReset: 100,
    taskValue: 50,
    secondaryQuality: 0.9,
    handoffCost: 20,
    delayCostPerMin: 1.0,
  });
  const waitCost = 1.0 * 100;  // c_d·τ
  const handoffCost = 20 + (1 - 0.9) * 50;  // h + (1−q')·v
  assert.equal(v.waitCost, Math.round(waitCost * 10) / 10);
  assert.equal(v.handoffTotalCost, Math.round(handoffCost * 10) / 10);
  assert.equal(v.waitCost > v.handoffTotalCost, true);
  assert.equal(v.recommend, "handoff");
});
