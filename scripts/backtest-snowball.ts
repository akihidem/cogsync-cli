#!/usr/bin/env node
/**
 * scripts/backtest-snowball.ts
 *
 * 過去全セッション (~/.claude/projects 配下) の各セッションでの累積トークン分布を集計し、
 * 雪だるま閾値の良し悪しを評価する。
 *
 * 使い方:
 *   npx tsx scripts/backtest-snowball.ts            # デフォルト集計
 *   npx tsx scripts/backtest-snowball.ts --json     # JSON 出力
 *   npx tsx scripts/backtest-snowball.ts --thresholds 80000,200000,500000,1000000,2000000
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { listSessionFiles, readSessionSamples } from "../src/observers/claude_code.ts";

type SessionSummary = {
  project: string;
  sessionId: string;
  samples: number;
  finalCumulative: number;
  duration_min: number;
};

const DEFAULT_THRESHOLDS = [50_000, 100_000, 200_000, 500_000, 1_000_000, 2_000_000, 5_000_000];

function summarize(logDir: string): { sessions: SessionSummary[]; totalSamples: number } {
  const files = listSessionFiles(logDir);
  const sessions: SessionSummary[] = [];
  let totalSamples = 0;
  for (const f of files) {
    const samples = readSessionSamples(f);
    if (samples.length === 0) continue;
    totalSamples += samples.length;
    const first = samples[0]!;
    const last = samples[samples.length - 1]!;
    sessions.push({
      project: f.project,
      sessionId: f.sessionId,
      samples: samples.length,
      finalCumulative: last.cumulativeUncached,
      duration_min: Math.max(0, Math.round((last.ts.getTime() - first.ts.getTime()) / 60000)),
    });
  }
  return { sessions, totalSamples };
}

function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  const idx = Math.min(sortedAsc.length - 1, Math.floor(sortedAsc.length * p));
  return sortedAsc[idx] ?? 0;
}

function fmtTok(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`;
  return String(n);
}

function main() {
  const args = process.argv.slice(2);
  const asJson = args.includes("--json");
  const thIdx = args.indexOf("--thresholds");
  const thresholds = thIdx >= 0 && args[thIdx + 1]
    ? args[thIdx + 1]!.split(",").map((s) => Number(s))
    : DEFAULT_THRESHOLDS;

  const logDir = join(homedir(), ".claude", "projects");
  const { sessions, totalSamples } = summarize(logDir);

  if (sessions.length === 0) {
    console.error(`no sessions found under ${logDir}`);
    process.exit(1);
  }

  const finals = sessions.map((s) => s.finalCumulative).sort((a, b) => a - b);
  const durations = sessions.map((s) => s.duration_min).sort((a, b) => a - b);
  const samplesArr = sessions.map((s) => s.samples).sort((a, b) => a - b);

  // 閾値ごとの「TRIG したセッション数」「TRIG したセッション中の中央到達分数」
  const byThreshold = thresholds.map((t) => {
    const triggered = sessions.filter((s) => s.finalCumulative >= t);
    return {
      threshold: t,
      sessions_triggered: triggered.length,
      pct_of_all: Math.round((triggered.length / sessions.length) * 100),
      median_final_kt: Math.round(
        percentile(triggered.map((s) => s.finalCumulative).sort((a, b) => a - b), 0.5) / 1000,
      ),
    };
  });

  const top10 = [...sessions]
    .sort((a, b) => b.finalCumulative - a.finalCumulative)
    .slice(0, 10);

  const summary = {
    sessions: sessions.length,
    total_samples: totalSamples,
    finalCumulative_distribution: {
      min: fmtTok(finals[0] ?? 0),
      p25: fmtTok(percentile(finals, 0.25)),
      p50: fmtTok(percentile(finals, 0.5)),
      p75: fmtTok(percentile(finals, 0.75)),
      p90: fmtTok(percentile(finals, 0.9)),
      p95: fmtTok(percentile(finals, 0.95)),
      p99: fmtTok(percentile(finals, 0.99)),
      max: fmtTok(finals[finals.length - 1] ?? 0),
    },
    samples_per_session: {
      median: percentile(samplesArr, 0.5),
      p95: percentile(samplesArr, 0.95),
    },
    duration_min_distribution: {
      median: percentile(durations, 0.5),
      p95: percentile(durations, 0.95),
    },
    by_threshold: byThreshold,
    top_10_heaviest: top10.map((s) => ({
      project: s.project,
      sessionId: s.sessionId.slice(0, 8),
      samples: s.samples,
      duration_min: s.duration_min,
      cumulative_kt: Math.round(s.finalCumulative / 1000),
    })),
  };

  if (asJson) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  console.log("=== cogsync backtest: snowball detection ===");
  console.log(`sessions: ${summary.sessions}, total samples: ${summary.total_samples}`);
  console.log("");
  console.log("final cumulative (input + cache_creation + output) distribution:");
  for (const [k, v] of Object.entries(summary.finalCumulative_distribution)) {
    console.log(`  ${k.padEnd(4)} ${v}`);
  }
  console.log("");
  console.log("by threshold (どれだけのセッションが triggered になるか):");
  console.log("  threshold     triggered  / total    pct    median final (kt)");
  for (const t of byThreshold) {
    console.log(
      `  ${fmtTok(t.threshold).padStart(8)}      ${String(t.sessions_triggered).padStart(4)} / ${String(sessions.length).padStart(4)}    ${String(t.pct_of_all).padStart(3)}%    ${t.median_final_kt}`,
    );
  }
  console.log("");
  console.log("top 10 heaviest sessions:");
  console.log("  project                                              session   samples  dur(min)  cum");
  for (const t of summary.top_10_heaviest) {
    console.log(
      `  ${t.project.padEnd(50)}  ${t.sessionId}  ${String(t.samples).padStart(7)}  ${String(t.duration_min).padStart(7)}  ${fmtTok(t.cumulative_kt * 1000)}`,
    );
  }
  console.log("");
  console.log("推奨閾値の選び方:");
  console.log("  - 上位 10〜20% のセッションだけ triggered にしたい → p80〜p90 付近");
  console.log("  - 「異常に重い」セッションだけ → p95〜p99");
}

main();
