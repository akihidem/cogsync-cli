#!/usr/bin/env node
/**
 * scripts/backtest-window5h.ts
 *
 * 過去の 5h ブロックを ccusage から取得し、消費パターンを集計する。
 * v0.1 段階のバックテスト：完了済みブロックは projection を持たないため、
 * 「実消費の分布」「枯渇近くまで使ったブロックの割合」「平均バーンレート」
 * を出すに留める。真の予測精度検証 (raw JSONL の時系列再生) は v0.2。
 *
 * 使い方:
 *   npx tsx scripts/backtest-window5h.ts            # 全ブロック集計
 *   npx tsx scripts/backtest-window5h.ts --json     # JSON 出力
 */

import { fetchAllBlocks } from "../src/observers/ccusage.ts";
import type { Window5hBlock } from "../src/observers/ccusage.ts";

type Summary = {
  totalBlocks: number;
  realBlocks: number; // gap を除く
  totalTokens: number;
  totalCostUSD: number;
  meanTokensPerBlock: number;
  medianTokensPerBlock: number;
  p95TokensPerBlock: number;
  meanDurationMin: number;
  meanBurnRateTokensPerMin: number;
  highBurnBlockCount: number; // 5h ウィンドウいっぱい使い切ったブロック数
  byModel: Record<string, { blocks: number; tokens: number; costUSD: number }>;
  recentBlocks: Array<{
    startedAt: string;
    durationMin: number;
    totalTokens: number;
    costUSD: number;
    models: string[];
    usagePctOfWindow: number; // 経過時間 / 300min
  }>;
};

function summarize(blocks: Window5hBlock[]): Summary {
  const real = blocks.filter((b) => !b.isGap);
  const tokens = real.map((b) => b.totalTokens).sort((a, b) => a - b);

  const total = real.reduce(
    (acc, b) => {
      acc.tokens += b.totalTokens;
      acc.cost += b.costUSD;
      return acc;
    },
    { tokens: 0, cost: 0 },
  );

  const durations = real.map((b) => durationMin(b));
  const meanDuration = avg(durations);

  const burnRates = real
    .filter((b) => durationMin(b) > 0)
    .map((b) => b.totalTokens / durationMin(b));
  const meanBurnRate = avg(burnRates);

  const highBurn = real.filter((b) => durationMin(b) >= 290).length; // 290 min ≈ ほぼ 5h 使い切り

  const byModel: Summary["byModel"] = {};
  for (const b of real) {
    for (const m of b.models) {
      const acc = byModel[m] ?? { blocks: 0, tokens: 0, costUSD: 0 };
      acc.blocks += 1;
      acc.tokens += b.totalTokens / b.models.length;
      acc.costUSD += b.costUSD / b.models.length;
      byModel[m] = acc;
    }
  }

  const recent = [...real]
    .sort((a, b) => b.startTime.getTime() - a.startTime.getTime())
    .slice(0, 10)
    .map((b) => ({
      startedAt: b.startTime.toISOString(),
      durationMin: durationMin(b),
      totalTokens: b.totalTokens,
      costUSD: round(b.costUSD, 4),
      models: b.models,
      usagePctOfWindow: Math.round((durationMin(b) / 300) * 100),
    }));

  return {
    totalBlocks: blocks.length,
    realBlocks: real.length,
    totalTokens: total.tokens,
    totalCostUSD: round(total.cost, 4),
    meanTokensPerBlock: Math.round(avg(tokens)),
    medianTokensPerBlock: Math.round(percentile(tokens, 0.5)),
    p95TokensPerBlock: Math.round(percentile(tokens, 0.95)),
    meanDurationMin: round(meanDuration, 1),
    meanBurnRateTokensPerMin: Math.round(meanBurnRate),
    highBurnBlockCount: highBurn,
    byModel: Object.fromEntries(
      Object.entries(byModel).map(([k, v]) => [
        k,
        { blocks: v.blocks, tokens: Math.round(v.tokens), costUSD: round(v.costUSD, 4) },
      ]),
    ),
    recentBlocks: recent,
  };
}

function durationMin(b: Window5hBlock): number {
  return Math.max(0, Math.round((b.actualEndTime.getTime() - b.startTime.getTime()) / 60000));
}

function avg(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  const idx = Math.min(sortedAsc.length - 1, Math.floor(sortedAsc.length * p));
  return sortedAsc[idx] ?? 0;
}

function round(n: number, digits: number): number {
  const f = Math.pow(10, digits);
  return Math.round(n * f) / f;
}

function fmtTok(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

async function main() {
  const args = process.argv.slice(2);
  const asJson = args.includes("--json");

  console.error("[backtest] fetching all blocks via ccusage...");
  const blocks = await fetchAllBlocks();
  const summary = summarize(blocks);

  if (asJson) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  console.log("=== cogsync backtest: 5h windows ===");
  console.log(`total blocks         : ${summary.totalBlocks} (real: ${summary.realBlocks}, gaps: ${summary.totalBlocks - summary.realBlocks})`);
  console.log(`total tokens         : ${fmtTok(summary.totalTokens)}`);
  console.log(`total cost (USD)     : $${summary.totalCostUSD}`);
  console.log("");
  console.log(`tokens per block     : mean ${fmtTok(summary.meanTokensPerBlock)} | median ${fmtTok(summary.medianTokensPerBlock)} | p95 ${fmtTok(summary.p95TokensPerBlock)}`);
  console.log(`mean duration        : ${summary.meanDurationMin} min`);
  console.log(`mean burn rate       : ${summary.meanBurnRateTokensPerMin.toLocaleString()} tok/min`);
  console.log(`high-burn blocks (>=290min) : ${summary.highBurnBlockCount} / ${summary.realBlocks}`);
  console.log("");
  console.log("by model:");
  for (const [m, v] of Object.entries(summary.byModel).sort((a, b) => b[1].tokens - a[1].tokens)) {
    console.log(`  ${m.padEnd(28)} blocks=${String(v.blocks).padStart(3)}  tokens=${fmtTok(v.tokens).padStart(8)}  cost=$${v.costUSD}`);
  }
  console.log("");
  console.log("recent 10 blocks:");
  console.log("  started_at                  dur(min)  tokens     cost($)  pctWin  models");
  for (const r of summary.recentBlocks) {
    console.log(
      `  ${r.startedAt}  ${String(r.durationMin).padStart(7)}  ${fmtTok(r.totalTokens).padStart(8)}  ${String(r.costUSD).padStart(7)}  ${String(r.usagePctOfWindow).padStart(5)}%  ${r.models.join(",")}`,
    );
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack : String(err));
  process.exit(1);
});
