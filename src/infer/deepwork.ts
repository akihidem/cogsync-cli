/**
 * infer: ディープワーク累積追跡
 * 当日の集中時間を分単位で集計する。MVP は手動セッション境界で測る。
 * v0.3 でアクティブ入力モニタ（マウス／キー）を任意で導入。
 *
 * 上限の根拠：Cal Newport "Deep Work"（達人クラスで 4h、初心者で 1-2h）。
 * cogsync (調査) report/02-cognition.md 参照。
 */

import { ymd } from "./work_state.ts";

export type DeepWorkAccum = {
  date: string; // YYYY-MM-DD
  totalMin: number;
  spans: { startedAt: Date; endedAt: Date; min: number }[];
};

export function todaysAccum(now: Date, spans: DeepWorkAccum["spans"]): DeepWorkAccum {
  // 「当日」= now のローカル日付。span はその開始日 (startedAt) でその日に属すと判定する。
  const date = ymd(now);
  const todays = spans.filter((s) => ymd(s.startedAt) === date);
  const totalMin = Math.round(todays.reduce((sum, s) => sum + s.min, 0));
  return { date, totalMin, spans: todays };
}

export function shouldWarnDailyCap(_accum: DeepWorkAccum, _capMin: number): boolean {
  return _accum.totalMin >= _capMin;
}
