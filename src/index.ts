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
  .version("1.0.0-alpha.0")
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
  .command("skill")
  .description("過去ログから並列稼働数の分布を推定し、parallelCapacity の推奨値を表示")
  .option("--days <n>", "対象期間 (日)", "30")
  .option("--bucket-sec <n>", "ビン幅 (秒)", "60")
  .option("--active-window-min <n>", "アクティブ判定の前後猶予 (分)", "5")
  .action(async (opts: { days: string; bucketSec: string; activeWindowMin: string }) => {
    const cliOpts = program.opts<{ config?: string }>();
    const { config } = loadConfig({ override: cliOpts.config });
    const { estimateSkillFromLogs } = await import("./infer/skill.ts");
    const est = estimateSkillFromLogs(config.observers.claudeCode.logDir, {
      recentDays: Number(opts.days),
      bucketSec: Number(opts.bucketSec),
      activeWindowMin: Number(opts.activeWindowMin),
    });
    if (!est) {
      console.error("no usable session data");
      process.exit(1);
    }
    console.log(`recommended parallelCapacity: ${est.recommendedParallel}`);
    console.log(`distribution (active bins):  median=${est.distribution.median}  p75=${est.distribution.p75}  p90=${est.distribution.p90}  max=${est.distribution.max}`);
    console.log(`bins: ${est.activeBins} active / ${est.observedBins} total | sessions: ${est.sessions}`);
    console.log("");
    console.log(`現在の config の parallelCapacity: ${config.profile.parallelCapacity}`);
    console.log(`設定変更例: ~/.config/cogsync/config.yaml に`);
    console.log(`  profile:`);
    console.log(`    parallelCapacity: ${est.recommendedParallel}`);
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
  .option("--llm", "現アクティブセッションから Ollama で自動要約 (--goal などと両立可、上書き)")
  .option("--ollama-url <url>", "Ollama URL", "http://localhost:11434")
  .option("--model <m>", "Ollama モデル", "gemma4:latest")
  .option("--no-clipboard", "クリップボードへコピーしない")
  .action(async (opts: {
    title?: string;
    goal?: string;
    state?: string;
    decision?: string[];
    question?: string[];
    next?: string;
    json?: string;
    llm?: boolean;
    ollamaUrl: string;
    model: string;
    clipboard: boolean;
  }) => {
    let struct: HandoffStruct;
    if (opts.llm) {
      const { snapshotRecentSessions } = await import("./observers/claude_code.ts");
      const { summarizeWithOllama } = await import("./handoff/llm.ts");
      const cliOpts = program.opts<{ config?: string }>();
      const { config } = (await import("./config.ts")).loadConfig({ override: cliOpts.config });
      const snap = snapshotRecentSessions(config.observers.claudeCode.logDir, 1);
      const top = snap[0];
      if (!top) {
        console.error("error: no active Claude session found");
        process.exit(2);
      }
      console.error(`[cogsync] summarizing ${top.file.sessionId.slice(0, 8)} via ${opts.model}...`);
      struct = await summarizeWithOllama(top.file.path, {
        ollamaUrl: opts.ollamaUrl,
        model: opts.model,
      });
      // CLI フラグで上書き
      if (opts.goal) struct.goal = opts.goal;
      if (opts.state) struct.state = opts.state;
      if (opts.next) struct.nextAction = opts.next;
      if (opts.decision && opts.decision.length > 0) struct.decisions = opts.decision;
      if (opts.question && opts.question.length > 0) struct.openQuestions = opts.question;
    } else if (opts.json) {
      struct = parseHandoffJson(opts.json);
    } else {
      const missing: string[] = [];
      if (!opts.goal) missing.push("--goal");
      if (!opts.state) missing.push("--state");
      if (!opts.next) missing.push("--next");
      if (missing.length > 0) {
        console.error(
          `error: missing required: ${missing.join(", ")}\n` +
            `       (or pass --json ... or --llm)`,
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
    const { isPhase, recommendedModelsFor, normalizeStartedAt, isPhaseStale } = await import(
      "./coach/phase.ts"
    );
    const { loadConfig } = await import("./config.ts");
    const store = new JsonStore();
    const { config } = loadConfig();

    if (action === "get") {
      const cur = store.getPhase();
      if (!cur) {
        console.log("phase: (未設定)");
        return;
      }
      const elapsedMin = Math.round(
        (Date.now() - normalizeStartedAt(cur).getTime()) / 60000,
      );
      const stale = isPhaseStale(cur, config.thresholds.phaseStaleHours);
      const staleSuffix = stale
        ? ` | ⚠️ ${config.thresholds.phaseStaleHours}h 以上経過 (stale)`
        : "";
      console.log(
        `phase: ${cur.phase} | 経過 ${elapsedMin} 分 | 推奨モデル: ${
          recommendedModelsFor(cur.phase).join(", ") || "(なし)"
        }${staleSuffix}`,
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
  .description("適応的ポモドーロ: pomodoro start [--focus 25] [--break 5] [--cycles 4] [--no-adaptive]")
  .argument("<action>", "start | stop")
  .option("--focus <n>", "集中分", "25")
  .option("--break <n>", "休憩分", "5")
  .option("--cycles <n>", "セット数 (0 で無限)", "0")
  .option(
    "--early-break-min <n>",
    "AI 処理待ちがこの分以上ならブレイクへ前倒し (0 で無効)",
    "8",
  )
  .action(async (action: string, opts: { focus: string; break: string; cycles: string; earlyBreakMin: string }) => {
    if (action !== "start") {
      console.error("supported: pomodoro start (stop は SIGINT で)");
      process.exit(2);
    }
    const { runAdaptivePomodoro } = await import("./timer/adaptive.ts");
    await runAdaptivePomodoro({
      focusMin: Number(opts.focus),
      breakMin: Number(opts.break),
      cycles: Number(opts.cycles),
      aiBusyEarlyBreakMin: Number(opts.earlyBreakMin),
    });
  });

program
  .command("mcp")
  .description("MCP サーバ起動（stdio）。Claude Code 等の MCP クライアントから cogsync の状態を読み取る用")
  .action(async () => {
    const { runMcpServer } = await import("./mcp/server.ts");
    await runMcpServer();
  });

program.parseAsync(process.argv);
