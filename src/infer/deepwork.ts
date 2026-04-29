/**
 * infer: ディープワーク累積追跡
 * 当日の集中時間を分単位で集計する。MVP は手動セッション境界で測る。
 * v0.3 でアクティブ入力モニタ（マウス／キー）を任意で導入。
 *
 * 上限の根拠：Cal Newport "Deep Work"（達人クラスで 4h、初心者で 1-2h）。
 * cogsync (調査) report/02-cognition.md 参照。
 */

export type DeepWorkAccum = {
  date: string; // YYYY-MM-DD
  totalMin: number;
  spans: { startedAt: Date; endedAt: Date; min: number }[];
};

export function todaysAccum(_now: Date, _spans: DeepWorkAccum["spans"]): DeepWorkAccum {
  // TODO v0.2
  throw new Error("todaysAccum not implemented (v0.2)");
}

export function shouldWarnDailyCap(_accum: DeepWorkAccum, _capMin: number): boolean {
  return _accum.totalMin >= _capMin;
}
