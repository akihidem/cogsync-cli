import { test } from "node:test";
import { strict as assert } from "node:assert";
import { isPhaseStale, type PhaseState } from "../src/coach/phase.ts";

test("isPhaseStale: staleHours=0 で常に false", () => {
  const s: PhaseState = { phase: "implement", startedAt: new Date(0).toISOString() };
  assert.equal(isPhaseStale(s, 0, new Date()), false);
});

test("isPhaseStale: 経過 < staleHours は false", () => {
  const now = new Date("2026-05-09T10:00:00Z");
  const s: PhaseState = { phase: "implement", startedAt: "2026-05-09T07:00:00Z" }; // 3h 前
  assert.equal(isPhaseStale(s, 6, now), false);
});

test("isPhaseStale: 経過 > staleHours は true", () => {
  const now = new Date("2026-05-09T10:00:00Z");
  const s: PhaseState = { phase: "implement", startedAt: "2026-05-09T03:00:00Z" }; // 7h 前
  assert.equal(isPhaseStale(s, 6, now), true);
});

test("isPhaseStale: Date 型の startedAt も受け付ける", () => {
  const now = new Date("2026-05-09T10:00:00Z");
  const s: PhaseState = { phase: "design", startedAt: new Date("2026-05-09T03:00:00Z") };
  assert.equal(isPhaseStale(s, 6, now), true);
});
