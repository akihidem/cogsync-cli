/**
 * infer: 雪だるま効果検出
 * 同一セッション内の累積トークンが閾値を超えたら true。
 * 閾値は config.thresholds.snowballToken（デフォルト 80,000）。
 *
 * v0.2 で実装。observers/claude_code.ts のセッションイベントを購読する形に変更予定。
 */

export type SessionTokenSample = {
  sessionId: string;
  ts: Date;
  cumulativeTokens: number;
};

export function detectSnowball(
  _samples: SessionTokenSample[],
  _threshold: number,
): { triggered: boolean; cumulativeTokens: number } {
  // TODO v0.2
  throw new Error("detectSnowball not implemented (v0.2)");
}
