/**
 * infer: skill (parallel capacity proxy)
 *
 * 過去セッションログから「実測された並列稼働数」をプロキシとしてスキル熟度を推定する。
 *
 * 方法:
 *   - 各セッションのイベント (assistant ts) を bucketSec 刻みでビン化
 *   - 各ビンに「アクティブだったセッション数」をカウント
 *   - その分布の p90 を parallelCapacity の推奨値とする
 *
 * 「アクティブ」 = そのビン時刻の ±activeWindowMin 分以内にアシスタント応答あり
 * （単に 1 イベントあった = まだ同時並行で動いていた、と解釈）
 *
 * 注意:
 *   - 「実際に並列稼働できた」≠「快適にレビューできる並列数」
 *   - これはあくまで「過去どれだけ並列で走らせていたか」のプロキシで、
 *     上限値の参考として使う。最終的にはユーザーの設定上書きが優先。
 */

import { listSessionFiles, readSessionSamples } from "../observers/claude_code.ts";

export type SkillEstimate = {
  /** 推奨される parallelCapacity (整数) */
  recommendedParallel: number;
  /** 並列度の分布 */
  distribution: {
    median: number;
    p75: number;
    p90: number;
    max: number;
  };
  /** 観測サンプル数 (ビン総数) */
  observedBins: number;
  /** 実際にアクティブだった (>=1 セッション) ビン数 */
  activeBins: number;
  /** 集計に使ったセッション数 */
  sessions: number;
};

export type EstimateOptions = {
  bucketSec?: number; // デフォ 60s
  activeWindowMin?: number; // デフォ 5min（このウィンドウ内に assistant 応答 = アクティブ）
  /** 直近 N 日に絞る (0 = すべて) */
  recentDays?: number;
};

export function estimateSkillFromLogs(
  logDir: string,
  opts: EstimateOptions = {},
): SkillEstimate | null {
  const bucketSec = opts.bucketSec ?? 60;
  const activeWindowMin = opts.activeWindowMin ?? 5;
  const recentDays = opts.recentDays ?? 30;

  const files = listSessionFiles(logDir);
  const cutoff =
    recentDays > 0 ? Date.now() - recentDays * 86_400_000 : 0;

  // session ごとに [活動時刻のソート済み配列]
  const perSession: Date[][] = [];
  for (const f of files) {
    const samples = readSessionSamples(f);
    if (samples.length === 0) continue;
    const filtered = samples
      .map((s) => s.ts)
      .filter((t) => t.getTime() >= cutoff);
    if (filtered.length === 0) continue;
    perSession.push(filtered);
  }
  if (perSession.length === 0) return null;

  // 集計範囲
  let minTs = Infinity;
  let maxTs = -Infinity;
  for (const arr of perSession) {
    for (const t of arr) {
      const v = t.getTime();
      if (v < minTs) minTs = v;
      if (v > maxTs) maxTs = v;
    }
  }
  if (!isFinite(minTs) || !isFinite(maxTs) || maxTs <= minTs) return null;

  const bucketMs = bucketSec * 1000;
  const halfWindowMs = activeWindowMin * 60_000;
  const bucketCount = Math.ceil((maxTs - minTs) / bucketMs) + 1;

  const counts = new Uint16Array(bucketCount);
  // 各セッションが活動的だったビンに +1（重複加算回避のため、セッション内では 1 ビンに最大 1 加算）
  for (const events of perSession) {
    const sessionBins = new Set<number>();
    for (const t of events) {
      // この event が「アクティブ」と見なされる範囲は (t - halfWindow, t + halfWindow)
      // = bucket idx (t - halfWindow - minTs) / bucketMs から (t + halfWindow - minTs) / bucketMs まで
      const startBucket = Math.max(0, Math.floor((t.getTime() - halfWindowMs - minTs) / bucketMs));
      const endBucket = Math.min(
        bucketCount - 1,
        Math.floor((t.getTime() + halfWindowMs - minTs) / bucketMs),
      );
      for (let b = startBucket; b <= endBucket; b++) {
        sessionBins.add(b);
      }
    }
    for (const b of sessionBins) {
      counts[b] = (counts[b] ?? 0) + 1;
    }
  }

  // 分布
  const activeCounts: number[] = [];
  for (let i = 0; i < counts.length; i++) {
    const c = counts[i] ?? 0;
    if (c > 0) activeCounts.push(c);
  }
  if (activeCounts.length === 0) return null;
  activeCounts.sort((a, b) => a - b);

  const median = percentile(activeCounts, 0.5);
  const p75 = percentile(activeCounts, 0.75);
  const p90 = percentile(activeCounts, 0.9);
  const max = activeCounts[activeCounts.length - 1] ?? 0;

  // 推奨値: p90 を採用、ただし 1〜10 でクリップ
  const recommendedParallel = Math.max(1, Math.min(10, Math.round(p90)));

  return {
    recommendedParallel,
    distribution: {
      median: Math.round(median),
      p75: Math.round(p75),
      p90: Math.round(p90),
      max,
    },
    observedBins: bucketCount,
    activeBins: activeCounts.length,
    sessions: perSession.length,
  };
}

function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  const idx = Math.min(sortedAsc.length - 1, Math.floor(sortedAsc.length * p));
  return sortedAsc[idx] ?? 0;
}
