/**
 * infer: 雪だるま効果検出
 * 同一セッション内の累積トークンが閾値を超えたら true。
 * 閾値は config.thresholds.snowballToken（デフォルト 80,000）。
 */

import type { UsageEvent } from "../observers/ccusage.ts";

export function detectSnowball(
  _eventsInSession: UsageEvent[],
  _threshold: number,
): { triggered: boolean; cumulativeTokens: number } {
  // TODO v0.2: input + cache_create の累積を集計
  throw new Error("detectSnowball not implemented (v0.2)");
}
