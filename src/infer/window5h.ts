/**
 * infer: 5h ローリングウィンドウ予測
 *
 * v0.1 では ccusage の projection.remainingMinutes をそのまま採用し、
 * 「ウィンドウ終了時刻」と「現バーンレート想定の枯渇時刻」を比較して、
 * 早い方を「実効的な残時間」として返す。
 *
 * 自前 EMA ベースの予測は v0.2 でバックテスト後に導入する。
 */

import type { Window5hBlock } from "../observers/ccusage.ts";

export type WindowStatus = {
  /** 5h ウィンドウの開始時刻 */
  startedAt: Date;
  /** 5h ウィンドウの終了時刻（startedAt + 5h） */
  endsAt: Date;
  /** 現在の累積トークン */
  consumedTokens: number;
  /** 現バーンレート想定の枯渇時刻（projection が無い場合は null） */
  estimatedExhaustionAt: Date | null;
  /** 残り分数（実効）。ウィンドウ終了と枯渇予測の早い方 */
  effectiveRemainingMinutes: number;
  /** 残り分数の根拠 */
  remainingReason: "window_end" | "burn_exhaustion";
  /** 直近のバーンレート（tokens/min）。表示用 */
  burnRateTokensPerMinute: number | null;
  /** モデル一覧 */
  models: string[];
};

export function computeWindowStatus(block: Window5hBlock, now: Date = new Date()): WindowStatus {
  const minsUntilWindowEnd = Math.max(0, Math.round((block.endTime.getTime() - now.getTime()) / 60000));
  const burnRemaining = block.projection?.remainingMinutes ?? null;

  let effectiveRemaining: number;
  let reason: WindowStatus["remainingReason"];
  let exhaustion: Date | null = null;

  if (burnRemaining !== null && burnRemaining < minsUntilWindowEnd) {
    effectiveRemaining = burnRemaining;
    reason = "burn_exhaustion";
    exhaustion = new Date(now.getTime() + burnRemaining * 60000);
  } else {
    effectiveRemaining = minsUntilWindowEnd;
    reason = "window_end";
  }

  return {
    startedAt: block.startTime,
    endsAt: block.endTime,
    consumedTokens: block.totalTokens,
    estimatedExhaustionAt: exhaustion,
    effectiveRemainingMinutes: effectiveRemaining,
    remainingReason: reason,
    burnRateTokensPerMinute: block.burnRate?.tokensPerMinuteForIndicator ?? null,
    models: block.models,
  };
}

export function formatStatusLine(status: WindowStatus): string {
  const parts: string[] = [];
  parts.push(`Claude 5h ウィンドウ`);

  const remainHrs = Math.floor(status.effectiveRemainingMinutes / 60);
  const remainMins = status.effectiveRemainingMinutes % 60;
  const remainStr = remainHrs > 0 ? `${remainHrs}h${remainMins}m` : `${remainMins}m`;
  parts.push(`残り ${remainStr}`);

  if (status.remainingReason === "burn_exhaustion" && status.estimatedExhaustionAt) {
    parts.push(`(枯渇予測 ${formatHHMM(status.estimatedExhaustionAt)} - 現バーンレート想定)`);
  } else {
    parts.push(`(終了 ${formatHHMM(status.endsAt)})`);
  }

  parts.push(`累計 ${formatTokens(status.consumedTokens)}`);

  if (status.burnRateTokensPerMinute) {
    parts.push(`${Math.round(status.burnRateTokensPerMinute).toLocaleString()} tok/min`);
  }

  return parts.join(" | ");
}

function formatHHMM(d: Date): string {
  const h = String(d.getHours()).padStart(2, "0");
  const m = String(d.getMinutes()).padStart(2, "0");
  return `${h}:${m}`;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}
