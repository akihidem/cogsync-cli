import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
  buildPhaseState,
  buildDeepWorkState,
} from "../src/mcp/resources.ts";
import type { PhaseState } from "../src/coach/phase.ts";

test("buildPhaseState: phase 未設定なら全 null", () => {
  const out = buildPhaseState(null, 6);
  assert.equal(out.phase, null);
  assert.equal(out.since, null);
  assert.equal(out.duration_min, null);
  assert.equal(out.stale, false);
  assert.deepEqual(out.recommended_models, []);
});

test("buildPhaseState: 経過 < staleHours で stale=false、推奨モデル付与", () => {
  const now = new Date("2026-05-09T10:00:00Z");
  const raw: PhaseState = { phase: "implement", startedAt: "2026-05-09T07:00:00Z" };
  const out = buildPhaseState(raw, 6, now);
  assert.equal(out.phase, "implement");
  assert.equal(out.since, "2026-05-09T07:00:00.000Z");
  assert.equal(out.duration_min, 180);
  assert.equal(out.stale, false);
  assert.ok(out.recommended_models.includes("claude-sonnet-4-6"));
});

test("buildPhaseState: 経過 > staleHours で stale=true", () => {
  const now = new Date("2026-05-09T10:00:00Z");
  const raw: PhaseState = { phase: "design", startedAt: "2026-05-09T03:00:00Z" };
  const out = buildPhaseState(raw, 6, now);
  assert.equal(out.stale, true);
  assert.ok(out.recommended_models.includes("claude-opus-4-7"));
});

test("buildDeepWorkState: 空入力で today=0 / history=[]", () => {
  const out = buildDeepWorkState(null, new Date("2026-05-09T10:00:00Z"));
  assert.equal(out.today.date, "2026-05-09");
  assert.equal(out.today.minutes, 0);
  assert.deepEqual(out.history, []);
});

test("buildDeepWorkState: 当日と過去日が混在しても today を正しく拾う", () => {
  const now = new Date("2026-05-09T10:00:00Z");
  const raw = {
    byDate: {
      "2026-05-08": 60 * 60_000, // 60 分
      "2026-05-09": 30 * 60_000, // 30 分
      "2026-05-07": 120 * 60_000, // 120 分
    },
  };
  const out = buildDeepWorkState(raw, now);
  assert.equal(out.today.minutes, 30);
  // history は日付昇順
  assert.deepEqual(
    out.history.map((h) => h.date),
    ["2026-05-07", "2026-05-08", "2026-05-09"],
  );
  assert.equal(out.history[2]!.minutes, 30);
});

test("buildDeepWorkState: today の日付フォーマットがゼロパディング", () => {
  // JST(UTC+9) を想定: 2026-01-03T05:00:00Z = JST 14:00 → 2026-01-03
  const out = buildDeepWorkState(null, new Date("2026-01-03T05:00:00Z"));
  assert.equal(out.today.date, "2026-01-03");
});
