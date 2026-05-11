/**
 * infer: 雪だるま効果検出
 *
 * 同一セッション内の累積トークン (input + cache_creation + output) が
 * 閾値を超えたら triggered。cache_read は除く（再利用なので「膨張」ではない）。
 *
 * セッション初手の cache_creation には SessionStart フックや CLAUDE.md /
 * MEMORY.md / system prompt の baseline 注入が含まれる。これは「初期コスト」
 * であって snowball ではないので、最初のサンプルの cacheCreation を baseline
 * として差し引く。さらに、ターン数が minTurns 未満のうちは実作業が浅すぎる
 * ので triggered を抑止する（heavy-context 起動時の誤発火を防ぐ）。
 *
 * 過去 30 日のバックテストで適切な閾値を再調整する余地あり
 * (scripts/backtest-snowball.ts 参照)。
 */

import type { SessionTokenSample } from "../observers/claude_code.ts";

export type SnowballState = {
  triggered: boolean;
  /** baseline 差し引き後の「成長分」累積。表示・通知もこれ。 */
  cumulativeTokens: number;
  /** 比較対象の閾値 */
  threshold: number;
  /** SessionStart 注入などで差し引いた baseline (最初の cache_creation) */
  baselineTokens: number;
  /** 現在のターン数（assistant サンプル数） */
  turns: number;
  /** 最小ターン数（これ未満なら triggered=false） */
  minTurns: number;
  /** triggered になった瞬間のサンプル時刻 */
  triggeredAt: Date | null;
  /** 最新サンプルの ts */
  latestAt: Date | null;
};

export function detectSnowball(
  samples: SessionTokenSample[],
  threshold: number,
  minTurns: number = 3,
): SnowballState {
  if (samples.length === 0) {
    return {
      triggered: false,
      cumulativeTokens: 0,
      threshold,
      baselineTokens: 0,
      turns: 0,
      minTurns,
      triggeredAt: null,
      latestAt: null,
    };
  }
  // 最初のサンプルの cache_creation を baseline として差し引く。
  // これにより「成長分」だけが snowball の物差しになる。
  const baseline = samples[0]!.tokens.cacheCreation;
  const latest = samples[samples.length - 1]!;
  const growth = Math.max(0, latest.cumulativeUncached - baseline);
  const turns = samples.length;
  const triggered = growth >= threshold && turns >= minTurns;

  let triggeredAt: Date | null = null;
  if (triggered) {
    // 初めて threshold を超えたサンプルを探す（前後 30 件まで線形）
    const start = Math.max(0, samples.length - 30);
    for (let i = start; i < samples.length; i++) {
      const g = Math.max(0, samples[i]!.cumulativeUncached - baseline);
      if (g >= threshold) {
        triggeredAt = samples[i]!.ts;
        break;
      }
    }
  }

  return {
    triggered,
    cumulativeTokens: growth,
    threshold,
    baselineTokens: baseline,
    turns,
    minTurns,
    triggeredAt,
    latestAt: latest.ts,
  };
}
