/**
 * infer: 雪だるま効果検出
 *
 * 同一セッション内の累積トークン (input + cache_creation + output) が
 * 閾値を超えたら triggered。cache_read は除く（再利用なので「膨張」ではない）。
 *
 * 過去 30 日のバックテストで適切な閾値を再調整する余地あり
 * (scripts/backtest-snowball.ts 参照)。
 */

import type { SessionTokenSample } from "../observers/claude_code.ts";

export type SnowballState = {
  triggered: boolean;
  cumulativeTokens: number;
  threshold: number;
  /** triggered になった瞬間のサンプル時刻 */
  triggeredAt: Date | null;
  /** 最新サンプルの ts */
  latestAt: Date | null;
};

export function detectSnowball(samples: SessionTokenSample[], threshold: number): SnowballState {
  if (samples.length === 0) {
    return {
      triggered: false,
      cumulativeTokens: 0,
      threshold,
      triggeredAt: null,
      latestAt: null,
    };
  }
  const latest = samples[samples.length - 1]!;
  const triggered = latest.cumulativeUncached >= threshold;

  let triggeredAt: Date | null = null;
  if (triggered) {
    // 初めて threshold を超えたサンプルを探す（前後 30 件まで線形）
    const start = Math.max(0, samples.length - 30);
    for (let i = start; i < samples.length; i++) {
      if (samples[i]!.cumulativeUncached >= threshold) {
        triggeredAt = samples[i]!.ts;
        break;
      }
    }
  }

  return {
    triggered,
    cumulativeTokens: latest.cumulativeUncached,
    threshold,
    triggeredAt,
    latestAt: latest.ts,
  };
}
