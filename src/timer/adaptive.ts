/**
 * timer: adaptive
 *
 * 適応的ポモドーロ:
 *   - 集中 (focus) フェーズ → ブレイク (break) フェーズの繰り返し
 *   - 集中フェーズ中に AI 処理待ち (ai_busy) が一定時間以上発生したら、
 *     ブレイク開始時刻を「いま」に前倒し（人間は既に手放している）
 *   - SIGINT で終了
 *
 * v0.3 MVP: AI 処理状態は claude_code observer の readLastEventTimestamps を
 *   ポーリングで取得（chokidar tail は v0.4 で接続）
 */

import { fileURLToPath } from "node:url";
import { findActiveSession } from "../observers/claude_code.ts";
import { classifyWorkState } from "../infer/work_state.ts";
import { createDesktopNotifier, type DesktopNotifier } from "../notify/desktop.ts";
import { loadConfig, type CogsyncConfig } from "../config.ts";

export type PomodoroOptions = {
  focusMin?: number;
  breakMin?: number;
  /** 集中中に ai_busy がこの分以上続いたらブレイクへ前倒し（0 で無効） */
  aiBusyEarlyBreakMin?: number;
  /** 何セット繰り返すか (0 で無限) */
  cycles?: number;
};

type Phase = "focus" | "break";

export async function runAdaptivePomodoro(opts: PomodoroOptions = {}): Promise<void> {
  const focusMin = opts.focusMin ?? 25;
  const breakMin = opts.breakMin ?? 5;
  const earlyBreakMin = opts.aiBusyEarlyBreakMin ?? 8;
  const cycles = opts.cycles ?? 0;

  const { config } = loadConfig();
  const notifier = createDesktopNotifier(config.notify.tone);

  let stopped = false;
  process.on("SIGINT", () => {
    if (stopped) return;
    stopped = true;
    console.log(`\n[pomodoro] interrupted, exiting.`);
  });
  process.on("SIGTERM", () => {
    if (stopped) return;
    stopped = true;
  });

  let cycle = 0;
  while (!stopped && (cycles === 0 || cycle < cycles)) {
    cycle += 1;
    await runFocus(notifier, focusMin, earlyBreakMin, config, () => stopped, cycle);
    if (stopped) break;
    await runBreak(notifier, breakMin, () => stopped, cycle);
  }
  console.log(`[pomodoro] done after ${cycle} cycle(s).`);
}

async function runFocus(
  notifier: DesktopNotifier,
  focusMin: number,
  earlyBreakMin: number,
  config: CogsyncConfig,
  isStopped: () => boolean,
  cycle: number,
): Promise<void> {
  const startedAt = Date.now();
  const endsAt = startedAt + focusMin * 60_000;
  console.log(
    `[pomodoro #${cycle}] focus ${focusMin} 分開始 (${hhmm(new Date(startedAt))} → ${hhmm(new Date(endsAt))})`,
  );
  await notifier.notify({
    template: "pomodoro_focus_started",
    severity: "info",
    vars: { cycle, focus_min: focusMin, ends_hhmm: hhmm(new Date(endsAt)) },
  });

  // 30 秒ごとにチェック (AI 処理状態と残時間)
  while (!isStopped()) {
    const now = Date.now();
    if (now >= endsAt) return;

    if (earlyBreakMin > 0) {
      const aiBusyMin = checkAiBusyDurationMin(
        config.observers.claudeCode.logDir,
        config.thresholds.activeSessionWindowMin,
      );
      if (aiBusyMin >= earlyBreakMin) {
        console.log(
          `[pomodoro #${cycle}] AI 処理待ち ${aiBusyMin.toFixed(1)} 分検出 → ブレイクへ前倒し`,
        );
        await notifier.notify({
          template: "pomodoro_focus_started",
          severity: "nudge",
          vars: { cycle, focus_min: 0, ends_hhmm: hhmm(new Date()) },
        });
        return;
      }
    }

    await sleep(30_000, isStopped);
  }
}

async function runBreak(
  notifier: DesktopNotifier,
  breakMin: number,
  isStopped: () => boolean,
  cycle: number,
): Promise<void> {
  const startedAt = Date.now();
  const endsAt = startedAt + breakMin * 60_000;
  console.log(
    `[pomodoro #${cycle}] break ${breakMin} 分開始 (${hhmm(new Date(startedAt))} → ${hhmm(new Date(endsAt))})`,
  );
  await notifier.notify({
    template: "pomodoro_break_started",
    severity: "info",
    vars: { cycle, break_min: breakMin, ends_hhmm: hhmm(new Date(endsAt)) },
  });
  while (!isStopped() && Date.now() < endsAt) {
    await sleep(15_000, isStopped);
  }
  if (isStopped()) return;
  await notifier.notify({
    template: "pomodoro_break_ended",
    severity: "info",
    vars: { cycle },
  });
}

/**
 * 真にアクティブなセッションでの ai_busy 継続分。
 * ai_busy でない、またはアクティブセッションが無い場合は 0。
 */
function checkAiBusyDurationMin(logDir: string, recentMin: number): number {
  try {
    const active = findActiveSession(logDir, recentMin);
    if (!active) return 0;
    const ws = classifyWorkState(active.lastUserAt, active.lastAssistantAt, new Date());
    if (ws.state !== "ai_busy" || !active.lastUserAt) return 0;
    return (Date.now() - active.lastUserAt.getTime()) / 60000;
  } catch {
    return 0;
  }
}

function sleep(ms: number, isStopped: () => boolean): Promise<void> {
  return new Promise((resolve) => {
    const interval = 250;
    let elapsed = 0;
    const id = setInterval(() => {
      elapsed += interval;
      if (elapsed >= ms || isStopped()) {
        clearInterval(id);
        resolve();
      }
    }, interval);
  });
}

function hhmm(d: Date): string {
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

// fileURLToPath は ESM 内のスクリプト直接実行検出を将来使う用。今は未使用。
void fileURLToPath;
