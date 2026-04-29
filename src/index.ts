#!/usr/bin/env bun
/**
 * cogsync-cli — entry point
 * Commands: watch / status / handoff / phase / pomodoro
 * 詳細は docs/DESIGN.md / docs/ROADMAP.md。実装は v0.1 で着手。
 */

import { Command } from "commander";

const program = new Command();

program
  .name("cogsync")
  .description("AI のリミット回復サイクルと人間の集中サイクルを同期させる CLI コーチ")
  .version("0.0.0");

program
  .command("status")
  .description("現在の状態を 1 行表示（5h ウィンドウ残量・現フェーズ等）")
  .action(() => {
    // TODO v0.1: observers から最新値を取得し、infer/window5h で残量を計算して表示
    console.log("cogsync status — not implemented yet (v0.1)");
  });

program
  .command("watch")
  .description("常駐モード。観測＋推論＋必要時の通知")
  .action(() => {
    // TODO v0.1: observers をスタートし、coach/advise の出力を notify/desktop に流す
    console.log("cogsync watch — not implemented yet (v0.1)");
  });

program
  .command("handoff")
  .description("ハンドオフ・プロンプトを生成して標準出力＋クリップボード")
  .action(() => {
    // TODO v0.2: handoff/template から生成
    console.log("cogsync handoff — not implemented yet (v0.2)");
  });

program
  .command("phase")
  .description("フェーズ手動切替: phase set design|implement|review|break")
  .argument("<action>", "set | get")
  .argument("[value]", "design | implement | review | break")
  .action((_action: string, _value?: string) => {
    // TODO v0.2: coach/phase に委譲
    console.log("cogsync phase — not implemented yet (v0.2)");
  });

program
  .command("pomodoro")
  .description("適応的ポモドーロ: pomodoro start|stop")
  .argument("<action>", "start | stop")
  .action((_action: string) => {
    // TODO v0.3: timer/adaptive に委譲
    console.log("cogsync pomodoro — not implemented yet (v0.3)");
  });

program.parseAsync(process.argv);
