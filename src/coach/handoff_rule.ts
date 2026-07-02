/**
 * coach: ハンドオフ閾値則（命題4）
 *
 * 主系（品質1）が τ に補充される状況で、残タスク（価値 v）を副系（品質 q'<1）へ
 * 移すか待つかを判定する。移すべきは待ちの費用が移行の費用を上回るとき、かつそのときに限る:
 *   delayCostPerMin·(τ−t) > handoffCost + (1−q')·v
 * cogsync 本体 §8.8。h（handoffCost）はハンドオフ・テンプレの質で下げられる。
 *
 * evaluateHandoffThreshold は純関数。readHandoffRuleInput は snapshot を読む IO アダプタ。
 */

import { readSnapshot } from "../observers/statusline_snapshot.ts";
import type { CogsyncConfig } from "../config.ts";

export type HandoffRecommend = "wait" | "handoff" | "unknown";

export type HandoffRuleInput = {
  /** 補充（5h 窓リセット）までの分数 τ−t。測れないなら null。 */
  minutesUntilReset: number | null;
  /** 残タスクの価値 v。 */
  taskValue: number;
  /** 副系の品質 q'（0-1）。1 なら同格（h だけが障壁）。 */
  secondaryQuality: number;
  /** ハンドオフ固定費用 h（コンテキスト再構築）。 */
  handoffCost: number;
  /** 遅延費用 /分 c_d。 */
  delayCostPerMin: number;
};

export type HandoffRuleVerdict = {
  recommend: HandoffRecommend;
  reason: string;
  /** 待ちの費用 c_d·(τ−t)。測れないなら null。 */
  waitCost: number | null;
  /** 移行の費用 h + (1−q')·v。 */
  handoffTotalCost: number;
  minutesUntilReset: number | null;
};

function nonNeg(x: number): number {
  return Number.isFinite(x) && x > 0 ? x : 0;
}

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return Math.min(1, Math.max(0, x));
}

export function evaluateHandoffThreshold(input: HandoffRuleInput): HandoffRuleVerdict {
  const v = nonNeg(input.taskValue);
  const qPrime = clamp01(input.secondaryQuality);
  const h = nonNeg(input.handoffCost);
  const cd = nonNeg(input.delayCostPerMin);
  const handoffTotalCost = round1(h + (1 - qPrime) * v);

  if (input.minutesUntilReset == null || !Number.isFinite(input.minutesUntilReset)) {
    return {
      recommend: "unknown",
      reason: "補充までの時間（5h 窓リセット）が観測できない（statusLine 未設定/stale）。判定不能。",
      waitCost: null,
      handoffTotalCost,
      minutesUntilReset: null,
    };
  }

  const tau = nonNeg(input.minutesUntilReset);
  const waitCost = round1(cd * tau);
  // 境界（待ち費用 == 移行費用）は wait（同値なら待つ＝移行固定費を無駄にしない・保守側）。
  if (waitCost > handoffTotalCost) {
    return {
      recommend: "handoff",
      reason: `待ち費用 ${waitCost} > 移行費用 ${handoffTotalCost}（補充まで ${Math.round(tau)} 分）。副系へ移す方が得。`,
      waitCost,
      handoffTotalCost,
      minutesUntilReset: round1(tau),
    };
  }
  return {
    recommend: "wait",
    reason: `待ち費用 ${waitCost} ≤ 移行費用 ${handoffTotalCost}（補充まで ${Math.round(tau)} 分）。補充を待つ方が得。`,
    waitCost,
    handoffTotalCost,
    minutesUntilReset: round1(tau),
  };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * statusline snapshot の fiveHour.resetsAt から τ−t（分）を出し、config の費用パラメータと
 * 合わせて HandoffRuleInput を組み立てる。snapshot 無し/stale/欠落は minutesUntilReset=null。
 */
export function readHandoffRuleInput(
  config: CogsyncConfig,
  now: Date,
  taskValue?: number,
): HandoffRuleInput {
  let minutesUntilReset: number | null = null;
  try {
    const snap = readSnapshot();
    const staleAfterMin = config.thresholds.weeklySnapshotStaleMin;
    const stale = snap != null && now.getTime() - snap.capturedAtEpochMs > staleAfterMin * 60_000;
    if (snap?.fiveHour && !stale) {
      const resetMs = snap.fiveHour.resetsAtEpochSec * 1000;
      const diffMin = (resetMs - now.getTime()) / 60_000;
      // 過去 reset（既にリセット済み＝窓は新鮮）は τ=0 として扱う（→ 待ち費用 0 ＝ wait）。
      minutesUntilReset = Number.isFinite(diffMin) ? Math.max(0, diffMin) : null;
    }
  } catch {
    minutesUntilReset = null;
  }
  return {
    minutesUntilReset,
    taskValue: taskValue ?? config.thresholds.handoffDefaultTaskValue,
    secondaryQuality: config.thresholds.handoffSecondaryQuality,
    handoffCost: config.thresholds.handoffReconstructCost,
    delayCostPerMin: config.thresholds.handoffDelayCostPerMin,
  };
}
