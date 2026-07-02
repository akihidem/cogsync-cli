/**
 * coach: アンカー・プライミング提案（命題2 + §9 E2）
 *
 * 5h ANCHORED 窓は最初の使用でエポックが開き、以後 5h は固定される（**アクティブな窓は
 * ping を送っても前倒しリセットできない。ping は現行窓を消費するだけ**）。プライミングが
 * 効くのはエポックが開いていないときで、最初の発話（or 軽い ping）が新しいエポックを開く。
 *
 * ここでは現在の窓状態と予定 deep 長から「deep を始める前に待つべきか（アクティブな窓が
 * 消費済みでセッション後までリセットしないと低予算になる）」を機械判定する。
 * 窓の再タイミング（境界を帯内に置く二重バースト・命題2）は将来の deep 開始時刻が要るため
 * v1 では扱わない（§非スコープ）。cogsync は AI を呼ばないので提案のみ。
 *
 * evaluatePriming は純関数。readPrimingInput は snapshot を読む IO アダプタ。
 */

import { readSnapshot } from "../observers/statusline_snapshot.ts";
import type { CogsyncConfig } from "../config.ts";

export type PrimingAction = "wait_for_reset" | "no_priming_needed" | "unknown";

export type PrimingInput = {
  /** 5h 窓リセットまでの分数。測れないなら null。 */
  minutesUntilReset: number | null;
  /** 5h 窓の使用率（0-100）。測れないなら null。 */
  fiveHourUsedPct: number | null;
  /** snapshot が stale か。 */
  snapshotStale: boolean;
  /** 予定している deep セッションの長さ（分）。 */
  deepDurationMin: number;
  /** この使用率未満なら「まだ新しい」＝プライミング不要とみなす閾値（%）。 */
  primeIfUsedPct: number;
};

export type PrimingVerdict = {
  action: PrimingAction;
  reason: string;
  minutesUntilReset: number | null;
  fiveHourUsedPct: number | null;
};

function nonNeg(x: number): number {
  return Number.isFinite(x) && x > 0 ? x : 0;
}

export function evaluatePriming(input: PrimingInput): PrimingVerdict {
  const deepMin = nonNeg(input.deepDurationMin);
  const threshold = nonNeg(input.primeIfUsedPct);

  // 1. データ無し → unknown（窓未追跡なら最初の発話で新窓が開くので実質プライミング不要）。
  if (input.fiveHourUsedPct == null || input.snapshotStale) {
    return {
      action: "unknown",
      reason:
        "5h 窓の状態が観測できない（statusLine 未設定/stale）。窓が開いていなければ最初の発話で新窓が開く（プライミング不要）。",
      minutesUntilReset: null,
      fiveHourUsedPct: null,
    };
  }

  const usedPct = Math.min(100, Math.max(0, input.fiveHourUsedPct));
  const mur = input.minutesUntilReset;

  // 2. 窓が期限切れ/リセット済み（reset が過去 or ちょうど 0）→ 次の発話で新窓が開く。不要。
  //    アクティブなエポックが無いので、最初の発話自体が自然なプライミングになる。
  if (mur != null && mur <= 0) {
    return {
      action: "no_priming_needed",
      reason:
        "直近の 5h 窓は期限切れ/リセット済み。次の発話（or 軽い ping）で新しい 5h 窓が開く。それが自然なプライミングなので追加操作は不要。",
      minutesUntilReset: mur != null ? round1(mur) : null,
      fiveHourUsedPct: round1(usedPct),
    };
  }

  // 3. まだ新しい → 不要。
  if (usedPct < threshold) {
    return {
      action: "no_priming_needed",
      reason: `5h 窓は ${round1(usedPct)}% 消費で十分新しい（閾値 ${round1(threshold)}%）。プライミング不要。`,
      minutesUntilReset: mur != null ? round1(mur) : null,
      fiveHourUsedPct: round1(usedPct),
    };
  }

  // 4. deep 中に自然リセット → 二重バーストが自然に効く。不要。
  if (mur != null && mur <= deepMin) {
    return {
      action: "no_priming_needed",
      reason: `窓は ${round1(mur)} 分後にリセット（セッション ${round1(deepMin)} 分の途中）。境界が帯内に来て予算が自然に二重化するので不要。`,
      minutesUntilReset: round1(mur),
      fiveHourUsedPct: round1(usedPct),
    };
  }

  // 5. アクティブな窓が消費済み・かつ deep 終了後までリセットしない → 低予算セッションになる。
  //    アクティブな窓は前倒しリセットできない（ping は現行窓を消費するだけ）。待つか低予算を受け入れる。
  const resetInfo = mur != null ? `${round1(mur)} 分後` : "セッション後";
  return {
    action: "wait_for_reset",
    reason: `アクティブな窓は ${round1(usedPct)}% 消費・リセットは ${resetInfo}（セッション ${round1(deepMin)} 分の後）。アクティブな窓は前倒しリセットできないので、deep 開始をリセットまで待つ（新窓で始める）か、低予算のセッションを受け入れる。`,
    minutesUntilReset: mur != null ? round1(mur) : null,
    fiveHourUsedPct: round1(usedPct),
  };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * statusline snapshot から PrimingInput を組み立てる IO アダプタ。
 * snapshot 無し/欠落/stale は「観測できない（unknown 経路）」に倒す（例外を投げない）。
 */
export function readPrimingInput(
  config: CogsyncConfig,
  now: Date,
  deepDurationMin?: number,
): PrimingInput {
  let snap = null;
  try {
    snap = readSnapshot();
  } catch {
    snap = null;
  }
  const staleAfterMin = config.thresholds.weeklySnapshotStaleMin;
  const snapshotStale =
    snap != null && now.getTime() - snap.capturedAtEpochMs > staleAfterMin * 60_000;
  const fiveHourUsedPct = snap?.fiveHour?.usedPct ?? null;
  let minutesUntilReset: number | null = null;
  if (snap?.fiveHour) {
    // 過去 reset（≤0）は null 化せず実値を渡す（期限切れ＝アクティブでない、を評価側が区別する）。
    const diffMin = (snap.fiveHour.resetsAtEpochSec * 1000 - now.getTime()) / 60_000;
    minutesUntilReset = Number.isFinite(diffMin) ? diffMin : null;
  }
  return {
    minutesUntilReset,
    fiveHourUsedPct,
    snapshotStale,
    deepDurationMin: deepDurationMin ?? config.thresholds.primeDefaultDeepDurationMin,
    primeIfUsedPct: config.thresholds.primeIfUsedPct,
  };
}
