/**
 * coach: リザーブゲート（自律バッチの実行可否判定）
 *
 * cron / banto 等の自律エージェントが「今バッチを走らせてよいか」を自主規制するための
 * 純関数。在席時間のための 5h 窓リザーブ（§8.7 P1 reserve(φ)・§9 E3 φ=0.3）と、週次枠
 * （§8.5 binding constraint）の 2 つを見て allow / hold / unknown を返す。
 *
 * evaluateReserveGate は副作用なし・純関数（時計は呼び手が snapshot 由来の値として渡す）。
 * readReserveInput は snapshot を読む薄い IO アダプタ（MCP tool と CLI が共用）。
 */

import { readSnapshot } from "../observers/statusline_snapshot.ts";
import { computeWeeklyStatus } from "../infer/weekly.ts";
import type { CogsyncConfig } from "../config.ts";

export type ReserveVerdictKind = "allow" | "hold" | "unknown";
export type ReserveBlockedBy = "five_hour_reserve" | "weekly_red";

export type ReserveGateInput = {
  /** statusline snapshot の fiveHour.usedPct（0-100）。無い/欠落なら null。 */
  fiveHourUsedPct: number | null;
  /** snapshot が stale（capturedAt が古い）か。true なら 5h は測れない扱い。 */
  snapshotStale: boolean;
  /** 週次 pacing のレベル。無ければ null。 */
  weeklyLevel: "green" | "yellow" | "red" | null;
  /** 週次 snapshot が stale か。 */
  weeklyStale: boolean;
  /** リザーブ率 φ（0-1）。残量がこれを割るバッチは走らせない。 */
  reservePhi: number;
  /** バッチが 5h 窓を追加消費する見込み（0-100 の pt）。省略時 0。 */
  estimatedUsagePct?: number;
  /** 5h が測れないとき（unknown）の既定挙動。 */
  onUnknown: "allow" | "deny";
};

export type ReserveVerdict = {
  allow: boolean;
  verdict: ReserveVerdictKind;
  reason: string;
  /** 5h 窓の残量（%）。測れないなら null。 */
  fiveHourRemainingPct: number | null;
  /** 適用したリザーブ率（%）。 */
  reservePct: number;
  blockedBy: ReserveBlockedBy[];
};

function clamp(x: number, lo: number, hi: number): number {
  if (!Number.isFinite(x)) return lo;
  return Math.min(hi, Math.max(lo, x));
}

export function evaluateReserveGate(input: ReserveGateInput): ReserveVerdict {
  const phi = clamp(input.reservePhi, 0, 1);
  const reservePct = Math.round(phi * 1000) / 10;

  // 1. 週次 red（fresh）は確定 hold。5h が測れるかや onUnknown に関係なく最優先。
  if (input.weeklyLevel === "red" && !input.weeklyStale) {
    const remaining =
      input.fiveHourUsedPct != null && !input.snapshotStale
        ? round1(100 - clamp(input.fiveHourUsedPct, 0, 100))
        : null;
    return {
      allow: false,
      verdict: "hold",
      reason: "週次枠が red（famine リスク）。リセットまで自律バッチは止める。",
      fiveHourRemainingPct: remaining,
      reservePct,
      blockedBy: ["weekly_red"],
    };
  }

  // 2. 5h が測れない（snapshot 無し/欠落/stale）→ unknown。onUnknown で allow を決める。
  if (input.fiveHourUsedPct == null || input.snapshotStale) {
    const allow = input.onUnknown === "allow";
    return {
      allow,
      verdict: "unknown",
      reason: allow
        ? "5h 残量が観測できない（statusLine 未設定/stale）。既定 allow で通す。"
        : "5h 残量が観測できない（statusLine 未設定/stale）。既定 deny で止める。",
      fiveHourRemainingPct: null,
      reservePct,
      blockedBy: [],
    };
  }

  // 3. 5h リザーブ侵食チェック。バッチ消費見込みを引いても φ を割らないか。
  const usedPct = clamp(input.fiveHourUsedPct, 0, 100);
  const remainingPct = round1(100 - usedPct);
  // usedPct / reservePhi と同じく防御的にクランプ（型は 0-100 だが純関数を直接呼ぶ経路もある）。
  const estUsage = clamp(input.estimatedUsagePct ?? 0, 0, 100);
  const projectedRemaining = (remainingPct - estUsage) / 100; // 0-1
  if (projectedRemaining < phi) {
    const detail =
      estUsage > 0
        ? `5h 残 ${remainingPct}% − 見込み ${estUsage}pt < リザーブ ${reservePct}%`
        : `5h 残 ${remainingPct}% < リザーブ ${reservePct}%`;
    return {
      allow: false,
      verdict: "hold",
      reason: `在席リザーブを侵食する（${detail}）。`,
      fiveHourRemainingPct: remainingPct,
      reservePct,
      blockedBy: ["five_hour_reserve"],
    };
  }

  // 4. 通過
  const detail =
    estUsage > 0
      ? `5h 残 ${remainingPct}% − 見込み ${estUsage}pt ≥ リザーブ ${reservePct}%`
      : `5h 残 ${remainingPct}% ≥ リザーブ ${reservePct}%`;
  return {
    allow: true,
    verdict: "allow",
    reason: `${detail}。走ってよい。`,
    fiveHourRemainingPct: remainingPct,
    reservePct,
    blockedBy: [],
  };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * statusline snapshot と config から ReserveGateInput を組み立てる IO アダプタ。
 * snapshot 読み取り失敗は「観測できない（unknown 経路）」に倒す（例外を投げない）。
 */
export function readReserveInput(
  config: CogsyncConfig,
  now: Date,
  estimatedUsagePct?: number,
): ReserveGateInput {
  let snap = null;
  try {
    snap = readSnapshot();
  } catch {
    snap = null;
  }
  // 鮮度は snapshot 単位の性質（capturedAt は 1 つ）なので、週次と同じ閾値を流用する。
  // 「週次は 60 分でよいがバッチゲートはもっと短く」を分けたくなったら専用 config を足す。
  const staleAfterMin = config.thresholds.weeklySnapshotStaleMin;
  const snapshotStale =
    snap != null && now.getTime() - snap.capturedAtEpochMs > staleAfterMin * 60_000;
  const fiveHourUsedPct = snap?.fiveHour?.usedPct ?? null;
  const weekly = snap
    ? computeWeeklyStatus(snap, now, {
        redMarginPct: config.thresholds.weeklyRedMarginPct,
        staleAfterMin,
      })
    : null;
  return {
    fiveHourUsedPct,
    snapshotStale,
    weeklyLevel: weekly?.level ?? null,
    weeklyStale: weekly?.stale ?? false,
    reservePhi: config.thresholds.reservePhi,
    estimatedUsagePct,
    onUnknown: config.thresholds.reserveGateOnUnknown,
  };
}
