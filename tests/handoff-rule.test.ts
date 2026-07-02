import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
  evaluateHandoffThreshold,
  type HandoffRuleInput,
} from "../src/coach/handoff_rule.ts";

function input(over: Partial<HandoffRuleInput> = {}): HandoffRuleInput {
  return {
    minutesUntilReset: 60,
    taskValue: 50,
    secondaryQuality: 0.9,
    handoffCost: 20,
    delayCostPerMin: 1.0,
    ...over,
  };
}

// 移行費用 = h + (1−q')·v = 20 + 0.1·50 = 25
// 待ち費用 = c_d·τ = 1.0·τ

test("待ち費用 > 移行費用 → handoff", () => {
  const v = evaluateHandoffThreshold(input({ minutesUntilReset: 180 })); // 180 > 25
  assert.equal(v.recommend, "handoff");
  assert.equal(v.waitCost, 180);
  assert.equal(v.handoffTotalCost, 25);
});

test("待ち費用 < 移行費用 → wait", () => {
  const v = evaluateHandoffThreshold(input({ minutesUntilReset: 10 })); // 10 < 25
  assert.equal(v.recommend, "wait");
  assert.equal(v.waitCost, 10);
});

test("境界: 待ち費用 == 移行費用 → wait（保守側）", () => {
  const v = evaluateHandoffThreshold(input({ minutesUntilReset: 25 })); // 25 == 25
  assert.equal(v.recommend, "wait");
});

test("minutesUntilReset null → unknown（waitCost=null）", () => {
  const v = evaluateHandoffThreshold(input({ minutesUntilReset: null }));
  assert.equal(v.recommend, "unknown");
  assert.equal(v.waitCost, null);
  assert.equal(v.handoffTotalCost, 25); // 移行費用は計算できる
});

test("q'=1（同格副系）は移行費用が h だけ", () => {
  const v = evaluateHandoffThreshold(input({ secondaryQuality: 1, taskValue: 100 }));
  assert.equal(v.handoffTotalCost, 20); // 20 + 0·100
});

test("q'>1 は 1 にクランプ・負の taskValue は 0 扱い", () => {
  const v = evaluateHandoffThreshold(input({ secondaryQuality: 5, taskValue: -100 }));
  assert.equal(v.handoffTotalCost, 20); // 20 + (1-1)·0
  const v2 = evaluateHandoffThreshold(input({ secondaryQuality: -1, taskValue: 100, minutesUntilReset: 5 }));
  // q'→0 なので移行費用 = 20 + 1·100 = 120。待ち 5 < 120 → wait
  assert.equal(v2.handoffTotalCost, 120);
  assert.equal(v2.recommend, "wait");
});

test("delayCostPerMin=0（待っても損しない）→ 常に wait", () => {
  const v = evaluateHandoffThreshold(input({ delayCostPerMin: 0, minutesUntilReset: 100000 }));
  assert.equal(v.recommend, "wait");
  assert.equal(v.waitCost, 0);
});

test("recommend と補助数値の整合", () => {
  for (const tau of [0, 10, 25, 26, 200]) {
    const v = evaluateHandoffThreshold(input({ minutesUntilReset: tau }));
    if (v.recommend === "handoff") assert.ok(v.waitCost! > v.handoffTotalCost);
    if (v.recommend === "wait") assert.ok(v.waitCost! <= v.handoffTotalCost);
  }
});
