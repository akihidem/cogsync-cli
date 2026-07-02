import { test } from "node:test";
import assert from "node:assert/strict";
import { advise, type AdviseInput } from "../src/coach/advise.ts";
import type { WeeklyStatus } from "../src/infer/weekly.ts";
import type { WindowStatus } from "../src/infer/window5h.ts";
import type { SnowballState } from "../src/infer/snowball.ts";

function baseInput(overrides: Partial<AdviseInput> = {}): AdviseInput {
  return {
    phase: "implement",
    window: null,
    snowball: null,
    workState: "active",
    aiBusyDurationMin: 0,
    deepWorkAccumMin: 0,
    parallelCapacity: 3,
    limitWarnMin: 15,
    dailyDeepWorkCapMin: 240,
    aiWaitBreakMin: 5,
    weekly: null,
    ...overrides,
  };
}

function triggeredSnowball(): SnowballState {
  return {
    triggered: true,
    cumulativeTokens: 200_000,
    threshold: 150_000,
    baselineTokens: 0,
    turns: 5,
    minTurns: 3,
    triggeredAt: new Date("2026-05-15T00:00:00Z"),
    latestAt: new Date("2026-05-15T00:10:00Z"),
  };
}

function approachingWindow(): WindowStatus {
  return {
    startedAt: new Date("2026-05-15T00:00:00Z"),
    endsAt: new Date("2026-05-15T05:00:00Z"),
    consumedTokens: 1_000_000,
    estimatedExhaustionAt: null,
    effectiveRemainingMinutes: 10, // <= limitWarnMin(15)
    remainingReason: "window_end",
    burnRateTokensPerMinute: null,
    models: ["claude-opus-4-7"],
  };
}

function weeklyStatus(overrides: Partial<WeeklyStatus> = {}): WeeklyStatus {
  return {
    level: "red",
    usedPct: 90,
    budgetLinePct: 70,
    paceDeltaPct: 20,
    windowStart: new Date("2026-05-12T00:00:00Z"),
    resetsAt: new Date("2026-05-19T00:00:00Z"),
    elapsedFraction: 0.5,
    projectedExhaustionAt: new Date("2026-05-16T09:00:00Z"),
    stale: false,
    capturedAt: new Date("2026-05-15T00:00:00Z"),
    ...overrides,
  };
}

// ─── 優先順位（L0 #4） ───────────────────────────────────────────────────────

test("advise: 雪だるま > 5h接近 > 週次red > deepwork cap の優先順位", () => {
  // 全条件が同時に成立していても、最優先の雪だるまだけが発火する
  const advAll = advise(
    baseInput({
      snowball: triggeredSnowball(),
      window: approachingWindow(),
      weekly: weeklyStatus(),
      deepWorkAccumMin: 999,
      deepWorkManualMin: 999,
    }),
  );
  assert.equal(advAll.action, "create_handoff");
  assert.equal(advAll.templateId, "snowball_detected");

  // 雪だるまなし → 5h 接近が次点
  const advWindow = advise(
    baseInput({
      window: approachingWindow(),
      weekly: weeklyStatus(),
      deepWorkAccumMin: 999,
      deepWorkManualMin: 999,
    }),
  );
  assert.equal(advWindow.action, "create_handoff");
  assert.equal(advWindow.templateId, "limit_approaching");

  // 雪だるま・5h接近なし → 週次 red が deepwork cap より先
  const advWeekly = advise(
    baseInput({
      weekly: weeklyStatus(),
      deepWorkAccumMin: 999,
      deepWorkManualMin: 999,
    }),
  );
  assert.equal(advWeekly.action, "throttle_batch");
  assert.equal(advWeekly.templateId, "weekly_pace_exceeded");

  // 週次もなければ deepwork cap が発火（既存優先順位の回帰確認）
  const advDeepwork = advise(
    baseInput({
      deepWorkAccumMin: 999,
      deepWorkManualMin: 999,
    }),
  );
  assert.equal(advDeepwork.action, "stop_for_today");
  assert.equal(advDeepwork.templateId, "deepwork_cap_reached");
});

// ─── rationale の必須要素 ────────────────────────────────────────────────────

test("advise: 週次 red 発火時の rationale・vars に必須要素を含む", () => {
  const input = baseInput({
    weekly: weeklyStatus({ paceDeltaPct: 12.3, budgetLinePct: 55.5, usedPct: 67.8 }),
  });
  const adv = advise(input);
  assert.equal(adv.action, "throttle_batch");
  assert.equal(adv.templateId, "weekly_pace_exceeded");
  assert.ok(adv.rationale.includes("pt"), "paceDeltaPct(pt) を含む");
  assert.ok(adv.rationale.includes("予算線"));
  assert.ok(adv.rationale.includes("消費"));
  assert.ok(adv.rationale.includes("に枯渇"), "projectedExhaustionAt ありなら枯渇見込みを含む");
  assert.equal(adv.vars?.["pace_delta_pt"], 12.3);
  assert.equal(adv.vars?.["budget_line_pct"], 55.5);
  assert.equal(adv.vars?.["used_pct"], 67.8);
});

test("advise: projectedExhaustionAt が null なら rationale は枯渇見込み文言を含まない", () => {
  const input = baseInput({ weekly: weeklyStatus({ projectedExhaustionAt: null }) });
  const adv = advise(input);
  assert.equal(adv.templateId, "weekly_pace_exceeded");
  assert.ok(!adv.rationale.includes("に枯渇"));
  assert.equal(adv.vars?.["projected_exhaustion_at"], "");
});

// ─── yellow / stale は発火しない（L0 #4） ────────────────────────────────────

test("advise: 週次 yellow は通知せず continue に落ちる", () => {
  const input = baseInput({ weekly: weeklyStatus({ level: "yellow", paceDeltaPct: 3 }) });
  const adv = advise(input);
  assert.equal(adv.action, "continue");
  assert.notEqual(adv.templateId, "weekly_pace_exceeded");
});

test("advise: 週次 green は通知せず continue に落ちる", () => {
  const input = baseInput({ weekly: weeklyStatus({ level: "green", paceDeltaPct: -5 }) });
  const adv = advise(input);
  assert.equal(adv.action, "continue");
  assert.notEqual(adv.templateId, "weekly_pace_exceeded");
});

test("advise: stale な週次 red は発火しない", () => {
  const input = baseInput({ weekly: weeklyStatus({ stale: true }) });
  const adv = advise(input);
  assert.equal(adv.action, "continue");
  assert.notEqual(adv.templateId, "weekly_pace_exceeded");
});

// ─── weekly 未指定時の後方互換 ───────────────────────────────────────────────

test("advise: weekly が null/undefined でも従来通り deepwork cap まで素通りする", () => {
  const nullCase = advise(
    baseInput({ weekly: null, deepWorkAccumMin: 999, deepWorkManualMin: 999 }),
  );
  assert.equal(nullCase.action, "stop_for_today");

  const undefinedCase = advise(
    baseInput({ weekly: undefined, deepWorkAccumMin: 999, deepWorkManualMin: 999 }),
  );
  assert.equal(undefinedCase.action, "stop_for_today");
});

test("advise: 週次 red の cap 到達（usedPct>=100）は『使い切り』文言と reason=cap_reached", () => {
  const adv = advise(
    baseInput({
      weekly: weeklyStatus({
        usedPct: 100,
        budgetLinePct: 100,
        paceDeltaPct: 0, // マージン超過ではなく 100% 到達で red になる経路
        level: "red",
        projectedExhaustionAt: null,
      }),
    }),
  );
  assert.equal(adv.action, "throttle_batch");
  assert.equal(adv.templateId, "weekly_pace_exceeded");
  assert.ok(adv.rationale.includes("使い切り"), `cap 到達の文言: ${adv.rationale}`);
  assert.ok(!adv.rationale.includes("超過"), "『+0pt 超過』のような不正確な表現をしない");
  assert.equal(adv.vars?.["reason"], "cap_reached");
});

test("advise: 週次 red の予算線超過経路は reason=pace_exceeded", () => {
  const adv = advise(baseInput({ weekly: weeklyStatus() }));
  assert.equal(adv.vars?.["reason"], "pace_exceeded");
});
