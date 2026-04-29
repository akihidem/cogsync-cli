/**
 * infer: 5h ローリングウィンドウ予測
 * 直近 30 分の消費速度を指数移動平均で推定し、枯渇時刻を線形外挿。
 * cogsync (調査) report/01-system-limits.md §2 と data/limits-2026q2.md 参照。
 */

import type { UsageEvent, Window5hSnapshot } from "../observers/ccusage.ts";

export type ConsumptionRate = {
  tokensPerMin: number;
  pctPerMin: number;
  basedOnSamples: number;
};

export function computeRate(_recent: UsageEvent[], _windowMin = 30): ConsumptionRate {
  // TODO v0.1: EMA（α=0.3 程度）で算出
  throw new Error("computeRate not implemented (v0.1)");
}

export function estimateExhaustion(
  _snapshot: Window5hSnapshot,
  _rate: ConsumptionRate,
): { estimatedAt: Date | null; minutesRemaining: number | null } {
  // TODO v0.1: snapshot.consumedPct と rate.pctPerMin から残時間を計算
  throw new Error("estimateExhaustion not implemented (v0.1)");
}
