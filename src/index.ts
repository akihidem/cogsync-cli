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

const program = new Command();

program
  .name("cogsync")
  .description("AI のリミット回復サイクルと人間の集中サイクルを同期させる CLI コーチ")
  .version("0.1.0-alpha.0")
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
  .description("常駐モード。観測＋推論＋必要時の通知（v0.1 実装中）")
  .action(() => {
    // TODO v0.1.x: setInterval で fetchActiveBlock をポーリング、閾値で通知発火
    console.log("cogsync watch — not implemented yet (v0.1.x)");
  });

program
  .command("handoff")
  .description("ハンドオフ・プロンプトを生成して標準出力＋クリップボード（v0.2）")
  .action(() => {
    console.log("cogsync handoff — not implemented yet (v0.2)");
  });

program
  .command("phase")
  .description("フェーズ手動切替: phase set design|implement|review|break（v0.2）")
  .argument("<action>", "set | get")
  .argument("[value]", "design | implement | review | break")
  .action((_action: string, _value?: string) => {
    console.log("cogsync phase — not implemented yet (v0.2)");
  });

program
  .command("pomodoro")
  .description("適応的ポモドーロ: pomodoro start|stop（v0.3）")
  .argument("<action>", "start | stop")
  .action((_action: string) => {
    console.log("cogsync pomodoro — not implemented yet (v0.3)");
  });

program.parseAsync(process.argv);
