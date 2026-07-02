import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeWeeklyStatus,
  formatWeeklyLine,
  formatWeeklySegment,
  type RateLimitSnapshot,
} from "../src/infer/weekly.ts";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const RESETS_AT = new Date("2026-05-19T00:00:00.000Z");
const WINDOW_START = new Date(RESETS_AT.getTime() - WEEK_MS);

function snapAt(usedPct: number, capturedAt: Date, resetsAt: Date = RESETS_AT): RateLimitSnapshot {
  return {
    sevenDay: { usedPct, resetsAtEpochSec: resetsAt.getTime() / 1000 },
    capturedAtEpochMs: capturedAt.getTime(),
  };
}

// ─── sevenDay 欠落 ───────────────────────────────────────────────────────────

test("computeWeeklyStatus: sevenDay 欠落は null（判定材料が無い）", () => {
  const snap: RateLimitSnapshot = {
    fiveHour: { usedPct: 10, resetsAtEpochSec: 1782033600 },
    capturedAtEpochMs: Date.now(),
  };
  assert.equal(computeWeeklyStatus(snap, new Date()), null);
});

// ─── level 境界（L0 #2: delta=0→green / +0.1→yellow / >14.29→red） ─────────

test("computeWeeklyStatus: 既定マージンでの level 境界 (delta=0→green / +0.1→yellow / 大幅超過→red)", () => {
  const now = new Date(WINDOW_START.getTime() + WEEK_MS * 0.5); // budgetLinePct=50

  const green = computeWeeklyStatus(snapAt(50, now), now)!;
  assert.equal(green.budgetLinePct, 50);
  assert.equal(green.paceDeltaPct, 0);
  assert.equal(green.level, "green");

  const yellow = computeWeeklyStatus(snapAt(50.1, now), now)!;
  assert.ok(yellow.paceDeltaPct > 0, "delta は正");
  assert.equal(yellow.level, "yellow");

  const red = computeWeeklyStatus(snapAt(70, now), now)!; // delta=20 > 100/7(≈14.29)
  assert.equal(red.level, "red");
});

test("computeWeeklyStatus: redMarginPct ちょうどは red にならない（狭義不等号）", () => {
  const now = new Date(WINDOW_START.getTime() + WEEK_MS * 0.5); // budgetLinePct=50

  const atMargin = computeWeeklyStatus(snapAt(60, now), now, { redMarginPct: 10 })!; // delta=10
  assert.equal(atMargin.paceDeltaPct, 10);
  assert.equal(atMargin.level, "yellow", "マージンと同値は red でない（> の狭義不等号）");

  const overMargin = computeWeeklyStatus(snapAt(60.5, now), now, { redMarginPct: 10 })!; // delta=10.5
  assert.equal(overMargin.level, "red");
});

test("computeWeeklyStatus: usedPct>=100 は paceDeltaPct がマージン以下でも red", () => {
  const now = RESETS_AT; // elapsedFraction はクランプされ 1、budgetLinePct=100
  const ws = computeWeeklyStatus(snapAt(100, now), now)!;
  assert.equal(ws.paceDeltaPct, 0, "delta はマージン以下");
  assert.equal(ws.level, "red", "usedPct>=100 は OR 条件で red");
});

// ─── 枯渇予測（L0 #2 数値例） ────────────────────────────────────────────────

test("computeWeeklyStatus: elapsed 50%・used 80% → windowStart+62.5%地点、リセット前なので非null", () => {
  const now = new Date(WINDOW_START.getTime() + WEEK_MS * 0.5);
  const ws = computeWeeklyStatus(snapAt(80, now), now)!;
  assert.equal(ws.elapsedFraction, 0.5);
  assert.notEqual(ws.projectedExhaustionAt, null);
  assert.deepEqual(ws.projectedExhaustionAt, new Date(WINDOW_START.getTime() + WEEK_MS * 0.625));
});

test("computeWeeklyStatus: elapsed 50%・used 40% はリセット後扱いになるため null", () => {
  const now = new Date(WINDOW_START.getTime() + WEEK_MS * 0.5);
  const ws = computeWeeklyStatus(snapAt(40, now), now)!;
  assert.equal(ws.projectedExhaustionAt, null);
});

// ─── 0 除算・例外なし境界（L0 #2） ───────────────────────────────────────────

test("computeWeeklyStatus: elapsedFraction=0 でも例外にならず projectedExhaustionAt は null", () => {
  const now = WINDOW_START; // elapsedFraction=0
  assert.doesNotThrow(() => computeWeeklyStatus(snapAt(10, now), now));
  const ws = computeWeeklyStatus(snapAt(10, now), now)!;
  assert.equal(ws.elapsedFraction, 0);
  assert.equal(ws.projectedExhaustionAt, null);
});

test("computeWeeklyStatus: usedPct=0 でも例外にならず projectedExhaustionAt は null", () => {
  const now = new Date(WINDOW_START.getTime() + WEEK_MS * 0.5);
  assert.doesNotThrow(() => computeWeeklyStatus(snapAt(0, now), now));
  const ws = computeWeeklyStatus(snapAt(0, now), now)!;
  assert.equal(ws.projectedExhaustionAt, null);
  assert.equal(ws.level, "green");
});

test("computeWeeklyStatus: now > resetsAt でも例外にならない（elapsedFraction は 1 にクランプ）", () => {
  const now = new Date(RESETS_AT.getTime() + 24 * 60 * 60 * 1000); // リセットの1日後
  assert.doesNotThrow(() => computeWeeklyStatus(snapAt(50, now), now));
  const ws = computeWeeklyStatus(snapAt(50, now), now)!;
  assert.equal(ws.elapsedFraction, 1);
});

// ─── stale 判定 ──────────────────────────────────────────────────────────────

test("computeWeeklyStatus: capturedAt から staleAfterMin 超過で stale=true", () => {
  const now = new Date(WINDOW_START.getTime() + WEEK_MS * 0.5);
  const capturedAt = new Date(now.getTime() - 61 * 60_000);
  const ws = computeWeeklyStatus(snapAt(50, capturedAt), now)!;
  assert.equal(ws.stale, true);
});

test("computeWeeklyStatus: staleAfterMin 未満なら stale=false", () => {
  const now = new Date(WINDOW_START.getTime() + WEEK_MS * 0.5);
  const capturedAt = new Date(now.getTime() - 59 * 60_000);
  const ws = computeWeeklyStatus(snapAt(50, capturedAt), now)!;
  assert.equal(ws.stale, false);
});

test("computeWeeklyStatus: staleAfterMin をオプションで上書きできる", () => {
  const now = new Date(WINDOW_START.getTime() + WEEK_MS * 0.5);
  const capturedAt = new Date(now.getTime() - 5 * 60_000);
  const ws = computeWeeklyStatus(snapAt(50, capturedAt), now, { staleAfterMin: 1 })!;
  assert.equal(ws.stale, true, "既定より短いしきい値を渡せば早く stale になる");
});

// ─── フォーマッタ（形状のみ。ローカル TZ 依存文字列は厳密比較しない） ────────

test("formatWeeklyLine / formatWeeklySegment: 1行の文字列を返す", () => {
  const now = new Date(WINDOW_START.getTime() + WEEK_MS * 0.5);
  const ws = computeWeeklyStatus(snapAt(80, now), now)!;

  const line = formatWeeklyLine(ws);
  assert.equal(typeof line, "string");
  assert.ok(line.includes(ws.level));
  assert.ok(!line.includes("\n"));

  const seg = formatWeeklySegment(ws);
  assert.equal(typeof seg, "string");
  assert.ok(seg.includes(ws.level));
  assert.ok(!seg.includes("\n"));
});

test("formatWeeklyLine: stale な snapshot は末尾に (stale) を含む", () => {
  const now = new Date(WINDOW_START.getTime() + WEEK_MS * 0.5);
  const capturedAt = new Date(now.getTime() - 61 * 60_000);
  const ws = computeWeeklyStatus(snapAt(50, capturedAt), now)!;
  assert.equal(ws.stale, true);
  assert.ok(formatWeeklyLine(ws).includes("(stale)"));
});

test("computeWeeklyStatus: Date 範囲外の resetsAtEpochSec でも Invalid Date を返さず null（出口防衛）", () => {
  const snap = {
    sevenDay: { usedPct: 100, resetsAtEpochSec: 1e20 },
    capturedAtEpochMs: Date.parse("2026-05-15T00:00:00Z"),
  };
  const ws = computeWeeklyStatus(snap, new Date("2026-05-15T01:00:00Z"));
  assert.equal(ws, null);
});

test("computeWeeklyStatus: 正常値の resetsAt は toISOString 可能（watch dedup の前提）", () => {
  const snap = {
    sevenDay: { usedPct: 50, resetsAtEpochSec: Math.floor(Date.parse("2026-05-19T00:00:00Z") / 1000) },
    capturedAtEpochMs: Date.parse("2026-05-15T00:00:00Z"),
  };
  const ws = computeWeeklyStatus(snap, new Date("2026-05-15T00:30:00Z"));
  assert.notEqual(ws, null);
  assert.doesNotThrow(() => ws!.resetsAt.toISOString());
});
