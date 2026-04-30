#!/usr/bin/env node
/**
 * cogsync-cli — entry point
 * Commands: status / watch / handoff / phase / pomodoro
 * 詳細は docs/DESIGN.md / docs/ROADMAP.md。
 */

import { Command } from "commander";
import { fetchActiveBlock, CcusageError } from "./observers/ccusage.ts";
import { computeWindowStatus, formatStatusLine } from "./infer/window5h.ts";
import { loadConfig } from "./config.ts";
import {
  renderStandard,
  parseHandoffJson,
  type HandoffStruct,
} from "./handoff/template.ts";
import { copyToClipboard } from "./util/clipboard.ts";

const program = new Command();

program
  .name("cogsync")
  .description("AI のリミット回復サイクルと人間の集中サイクルを同期させる CLI コーチ")
  .version("0.2.0-alpha.0")
  .option("--config <path>", "設定ファイルパス（既定 ~/.config/cogsync/config.yaml、env COGSYNC_CONFIG でも上書き）");

program
  .command("config")
  .description("解決後の設定を表示（デバッグ用）")
  .action(() => {
    const opts = program.opts<{ config?: string }>();
    const { config, loadedFrom } = loadConfig({ override: opts.config });
    console.log(`# loaded from: ${loadedFrom.join(" > ")}`);
    console.log(JSON.stringify(config, null, 2));
  });

program
  .command("status")
  .description("現在の 5h ウィンドウ残量を 1 行表示")
  .option("--json", "JSON 形式で出力（プログラムから消費する用）")
  .option("--timeout <ms>", "ccusage 呼び出しのタイムアウト (ms)", "30000")
  .action(async (opts: { json?: boolean; timeout: string }) => {
    try {
      const block = await fetchActiveBlock(Number(opts.timeout));
      if (!block) {
        if (opts.json) {
          console.log(JSON.stringify({ active: false }));
        } else {
          console.log("Claude 5h ウィンドウ: アクティブなブロックなし（直近 5 時間に Claude Code 未使用）");
        }
        return;
      }
      const status = computeWindowStatus(block);
      if (opts.json) {
        console.log(JSON.stringify({ active: true, status }, null, 2));
      } else {
        console.log(formatStatusLine(status));
      }
    } catch (err) {
      if (err instanceof CcusageError) {
        console.error(`error: ${err.message}`);
      } else if (err instanceof Error) {
        console.error(`unexpected: ${err.message}`);
      } else {
        console.error("unknown error");
      }
      process.exit(1);
    }
  });

program
  .command("watch")
  .description("常駐モード。ポーリングでリミットを観測し、閾値超えで通知")
  .option("--polling-sec <n>", "ポーリング間隔(秒)。設定値を上書き")
  .option("--once", "1 回だけ実行して終了（動作確認用）")
  .action(async (opts: { pollingSec?: string; once?: boolean }) => {
    const cliOpts = program.opts<{ config?: string }>();
    const { loadConfig } = await import("./config.ts");
    const { runWatch } = await import("./watch.ts");
    const { config } = loadConfig({ override: cliOpts.config });
    await runWatch({
      config,
      pollingSecOverride: opts.pollingSec ? Number(opts.pollingSec) : undefined,
      once: opts.once,
    });
  });

program
  .command("handoff")
  .description("ハンドオフ・プロンプトを生成して標準出力＋クリップボード")
  .option("--title <s>", "ハンドオフのタイトル")
  .option("--goal <s>", "目標")
  .option("--state <s>", "現状")
  .option("--decision <s...>", "確定事項（複数可）", [])
  .option("--question <s...>", "未解決の論点（複数可）", [])
  .option("--next <s>", "次のアクション")
  .option("--json <s>", "JSON 文字列で一括指定（個別 --flag より優先）")
  .option("--no-clipboard", "クリップボードへコピーしない")
  .action(async (opts: {
    title?: string;
    goal?: string;
    state?: string;
    decision?: string[];
    question?: string[];
    next?: string;
    json?: string;
    clipboard: boolean;
  }) => {
    let struct: HandoffStruct;
    if (opts.json) {
      struct = parseHandoffJson(opts.json);
    } else {
      const missing: string[] = [];
      if (!opts.goal) missing.push("--goal");
      if (!opts.state) missing.push("--state");
      if (!opts.next) missing.push("--next");
      if (missing.length > 0) {
        console.error(
          `error: missing required: ${missing.join(", ")}\n` +
            `       (or pass --json '{"goal":"...","state":"...","nextAction":"...","decisions":[...],"openQuestions":[...]}')`,
        );
        process.exit(2);
      }
      struct = {
        goal: opts.goal!,
        state: opts.state!,
        nextAction: opts.next!,
        decisions: opts.decision ?? [],
        openQuestions: opts.question ?? [],
      };
    }

    const out = renderStandard(struct, opts.title);
    process.stdout.write(out.text);

    if (opts.clipboard) {
      const r = await copyToClipboard(out.text);
      if (r.ok) {
        console.error(`\n[cogsync] copied to clipboard via ${r.via}`);
      } else {
        console.error(
          `\n[cogsync] clipboard copy failed (tried: ${r.tried.join(", ")}). text printed to stdout above.`,
        );
      }
    }
  });

program
  .command("phase")
  .description("フェーズ手動切替: phase set design|implement|review|break / phase get")
  .argument("<action>", "set | get")
  .argument("[value]", "design | implement | review | break (set 時のみ)")
  .action(async (action: string, value: string | undefined) => {
    const { JsonStore } = await import("./state/store.ts");
    const { isPhase, recommendedModelsFor, normalizeStartedAt } = await import("./coach/phase.ts");
    const store = new JsonStore();

    if (action === "get") {
      const cur = store.getPhase();
      if (!cur) {
        console.log("phase: (未設定)");
        return;
      }
      const elapsedMin = Math.round(
        (Date.now() - normalizeStartedAt(cur).getTime()) / 60000,
      );
      console.log(
        `phase: ${cur.phase} | 経過 ${elapsedMin} 分 | 推奨モデル: ${
          recommendedModelsFor(cur.phase).join(", ") || "(なし)"
        }`,
      );
      return;
    }

    if (action === "set") {
      if (!value || !isPhase(value)) {
        console.error("error: phase set <design|implement|review|break>");
        process.exit(2);
      }
      const next = store.setPhase(value);
      console.log(
        `phase: ${next.phase} (set at ${normalizeStartedAt(next).toISOString()}) | 推奨モデル: ${
          recommendedModelsFor(next.phase).join(", ") || "(なし)"
        }`,
      );
      return;
    }

    console.error(`error: unknown action: ${action}. expected get|set`);
    process.exit(2);
  });

program
  .command("pomodoro")
  .description("適応的ポモドーロ: pomodoro start|stop（v0.3）")
  .argument("<action>", "start | stop")
  .action((_action: string) => {
    console.log("cogsync pomodoro — not implemented yet (v0.3)");
  });

program.parseAsync(process.argv);
