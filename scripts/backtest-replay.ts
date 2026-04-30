#!/usr/bin/env node
/**
 * scripts/backtest-replay.ts
 *
 * 過去セッションを raw JSONL から時系列再生し、
 * 「いつ snowball triggered になったか」「いつ active/ai_busy/idle に切り替わったか」を可視化。
 *
 * 使い方:
 *   npx tsx scripts/backtest-replay.ts                       # 直近 5 セッション
 *   npx tsx scripts/backtest-replay.ts --limit 20            # 直近 20 セッション
 *   npx tsx scripts/backtest-replay.ts --threshold 200000    # snowball 閾値
 *   npx tsx scripts/backtest-replay.ts --json                # JSON 出力
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { listSessionFiles, readSessionSamples } from "../src/observers/claude_code.ts";

type ReplayResult = {
  project: string;
  sessionId: string;
  durationMin: number;
  finalCumulativeKt: number;
  triggeredAtMin: number | null;
  /** trigger 時のサンプルインデックス */
  triggeredAtIdx: number | null;
  models: string[];
};

const DEFAULT_LIMIT = 5;
const DEFAULT_THRESHOLD = 150_000;

function replaySession(
  file: { path: string; sessionId: string; project: string },
  threshold: number,
): ReplayResult | null {
  const samples = readSessionSamples(file as any);
  if (samples.length === 0) return null;
  const first = samples[0]!;
  const last = samples[samples.length - 1]!;
  const durationMin = Math.max(0, (last.ts.getTime() - first.ts.getTime()) / 60000);

  let triggeredAtIdx: number | null = null;
  let triggeredAtMin: number | null = null;
  for (let i = 0; i < samples.length; i++) {
    if (samples[i]!.cumulativeUncached >= threshold) {
      triggeredAtIdx = i;
      triggeredAtMin = (samples[i]!.ts.getTime() - first.ts.getTime()) / 60000;
      break;
    }
  }

  const modelSet = new Set<string>();
  for (const s of samples) modelSet.add(s.model);

  return {
    project: file.project,
    sessionId: file.sessionId,
    durationMin: Math.round(durationMin),
    finalCumulativeKt: Math.round(last.cumulativeUncached / 1000),
    triggeredAtMin: triggeredAtMin === null ? null : Math.round(triggeredAtMin * 10) / 10,
    triggeredAtIdx,
    models: [...modelSet],
  };
}

function fmtTokKt(kt: number): string {
  if (kt >= 1000) return `${(kt / 1000).toFixed(2)}M`;
  return `${kt}k`;
}

function main() {
  const args = process.argv.slice(2);
  const asJson = args.includes("--json");

  const limitIdx = args.indexOf("--limit");
  const limit = limitIdx >= 0 && args[limitIdx + 1] ? Number(args[limitIdx + 1]) : DEFAULT_LIMIT;

  const thIdx = args.indexOf("--threshold");
  const threshold = thIdx >= 0 && args[thIdx + 1] ? Number(args[thIdx + 1]) : DEFAULT_THRESHOLD;

  const logDir = join(homedir(), ".claude", "projects");
  const files = listSessionFiles(logDir).slice(0, limit);

  const results: ReplayResult[] = [];
  for (const f of files) {
    const r = replaySession(f, threshold);
    if (r) results.push(r);
  }

  // 集計
  const triggered = results.filter((r) => r.triggeredAtMin !== null);
  const avgTriggerMin =
    triggered.length === 0
      ? 0
      : Math.round(
          (triggered.reduce((a, b) => a + (b.triggeredAtMin ?? 0), 0) / triggered.length) * 10,
        ) / 10;

  if (asJson) {
    console.log(JSON.stringify({ threshold, limit, results, avgTriggerMin }, null, 2));
    return;
  }

  console.log("=== cogsync backtest: replay (snowball trigger timing) ===");
  console.log(`threshold: ${fmtTokKt(threshold / 1000)}, sessions: ${results.length}`);
  console.log(`triggered: ${triggered.length} / ${results.length}`);
  console.log(`avg trigger time after session start: ${avgTriggerMin} min`);
  console.log("");
  console.log("session                                      dur    final     trig@(min)  trig@(sample idx)  models");
  for (const r of results) {
    const tag = r.triggeredAtMin === null ? "-".padStart(11) : `${r.triggeredAtMin.toString().padStart(8)} m`;
    const idx = r.triggeredAtIdx === null ? "-" : String(r.triggeredAtIdx);
    const proj = (r.project + "/" + r.sessionId.slice(0, 8)).padEnd(40);
    console.log(
      `${proj}  ${String(r.durationMin).padStart(5)}m  ${fmtTokKt(r.finalCumulativeKt).padStart(7)}  ${tag}  ${String(idx).padStart(6)}            ${r.models.join(",")}`,
    );
  }
}

main();
