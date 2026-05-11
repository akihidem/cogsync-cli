import { test } from "node:test";
import assert from "node:assert/strict";
import { detectSnowball } from "../src/infer/snowball.ts";
import type { SessionTokenSample } from "../src/observers/claude_code.ts";

function sample(
  cumulative: number,
  cacheCreation: number,
  ts = new Date("2026-05-12T00:00:00Z"),
): SessionTokenSample {
  return {
    sessionId: "t",
    ts,
    cumulativeUncached: cumulative,
    tokens: { input: 0, output: 0, cacheCreation, cacheRead: 0 },
    model: "claude-opus-4-7",
  };
}

test("detectSnowball: 空入力は triggered=false", () => {
  const s = detectSnowball([], 150_000);
  assert.equal(s.triggered, false);
  assert.equal(s.cumulativeTokens, 0);
  assert.equal(s.turns, 0);
});

test("detectSnowball: 最初のサンプルの cacheCreation を baseline として差し引く", () => {
  // baseline 200k（SessionStart 注入）。最新累積 250k → 成長分 50k。
  const samples = [
    sample(200_000, 200_000, new Date("2026-05-12T00:00:00Z")),
    sample(220_000, 0, new Date("2026-05-12T00:05:00Z")),
    sample(250_000, 0, new Date("2026-05-12T00:10:00Z")),
  ];
  const s = detectSnowball(samples, 150_000, 3);
  assert.equal(s.baselineTokens, 200_000);
  assert.equal(s.cumulativeTokens, 50_000);
  assert.equal(s.triggered, false, "baseline 差し引き後は閾値未満");
});

test("detectSnowball: ターン数が minTurns 未満なら閾値超でも triggered=false", () => {
  // baseline 0、成長分 200k だが 2 ターンしか無い
  const samples = [
    sample(0, 0, new Date("2026-05-12T00:00:00Z")),
    sample(200_000, 0, new Date("2026-05-12T00:05:00Z")),
  ];
  const s = detectSnowball(samples, 150_000, 3);
  assert.equal(s.cumulativeTokens, 200_000);
  assert.equal(s.turns, 2);
  assert.equal(s.triggered, false, "minTurns 未満は抑止");
});

test("detectSnowball: baseline 控除後の成長分が閾値を超え、かつ minTurns 以上なら triggered", () => {
  const samples = [
    sample(100_000, 100_000, new Date("2026-05-12T00:00:00Z")),
    sample(150_000, 0, new Date("2026-05-12T00:05:00Z")),
    sample(260_000, 0, new Date("2026-05-12T00:10:00Z")),
    sample(360_000, 0, new Date("2026-05-12T00:15:00Z")),
  ];
  const s = detectSnowball(samples, 150_000, 3);
  assert.equal(s.baselineTokens, 100_000);
  assert.equal(s.cumulativeTokens, 260_000);
  assert.equal(s.triggered, true);
  // 初めて閾値超えた瞬間は累積 260k のサンプル (3 件目)
  assert.deepEqual(s.triggeredAt, new Date("2026-05-12T00:10:00Z"));
});

test("detectSnowball: heavy SessionStart で初手 300k でも 1 ターンなら誤発火しない", () => {
  // ユーザーの実環境を模擬: 初手の cache_creation で 307k 食う
  const samples = [sample(307_000, 307_000, new Date("2026-05-12T00:00:00Z"))];
  const s = detectSnowball(samples, 150_000, 3);
  assert.equal(s.cumulativeTokens, 0, "成長分はゼロ");
  assert.equal(s.triggered, false);
});
