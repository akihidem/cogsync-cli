import { test } from "node:test";
import { strict as assert } from "node:assert";
import { todaysAccum } from "../src/infer/deepwork.ts";

// Date はローカル成分で構築する（ymd がローカル日付を使うため、TZ 非依存にする）。
const span = (y: number, mo: number, d: number, h: number, mi: number, min: number) => ({
  startedAt: new Date(y, mo - 1, d, h, mi),
  endedAt: new Date(y, mo - 1, d, h, mi + min),
  min,
});

test("todaysAccum: 当日の span だけ合計し、前日・翌日は除外する", () => {
  const now = new Date(2026, 4, 9, 12, 0); // 2026-05-09 ローカル
  const spans = [
    span(2026, 5, 9, 9, 0, 30), // 当日 +30
    span(2026, 5, 9, 13, 0, 15), // 当日 +15
    span(2026, 5, 8, 23, 0, 45), // 前日 → 除外
    span(2026, 5, 10, 1, 0, 20), // 翌日 → 除外
  ];
  const acc = todaysAccum(now, spans);
  assert.equal(acc.date, "2026-05-09");
  assert.equal(acc.totalMin, 45); // 30 + 15 のみ
  assert.equal(acc.spans.length, 2);
});

test("todaysAccum: span が無ければ totalMin=0 / spans=[]（throw しない）", () => {
  const now = new Date(2026, 4, 9, 12, 0);
  const acc = todaysAccum(now, []);
  assert.equal(acc.date, "2026-05-09");
  assert.equal(acc.totalMin, 0);
  assert.deepEqual(acc.spans, []);
});

test("todaysAccum: 端数分は合計後に四捨五入する", () => {
  const now = new Date(2026, 4, 9, 12, 0);
  const spans = [span(2026, 5, 9, 9, 0, 1.4), span(2026, 5, 9, 10, 0, 1.4)];
  const acc = todaysAccum(now, spans);
  assert.equal(acc.totalMin, 3); // 2.8 → 3
});

test("todaysAccum: startedAt が当日なら endedAt が翌日でも当日に丸ごと計上（跨ぎ仕様）", () => {
  const now = new Date(2026, 4, 9, 12, 0);
  const spans = [
    { startedAt: new Date(2026, 4, 9, 23, 50), endedAt: new Date(2026, 4, 10, 0, 20), min: 30 },
  ];
  const acc = todaysAccum(now, spans);
  assert.equal(acc.totalMin, 30); // startedAt 基準で当日に全量
  assert.equal(acc.spans.length, 1);
});
