/**
 * watch: 常駐ループ
 *
 * v0.2:
 * - ccusage 5h ブロック観測 (window5h)
 * - raw JSONL スナップショット + 雪だるま検出 (snowball)
 * - phase store 参照
 * - coach/advise でアクション選択 → notify
 *
 * 同種通知は (block.id + templateId) または (sessionId + templateId) で dedup。
 * SIGINT/SIGTERM でグレースフル終了。
 */

import { fetchActiveBlock, CcusageError } from "./observers/ccusage.ts";
import { computeWindowStatus, formatStatusLine, type WindowStatus } from "./infer/window5h.ts";
import { snapshotRecentSessions } from "./observers/claude_code.ts";
import { detectSnowball, type SnowballState } from "./infer/snowball.ts";
import { advise, type Advice } from "./coach/advise.ts";
import { createDesktopNotifier, type NotifyRequest } from "./notify/desktop.ts";
import { JsonStore } from "./state/store.ts";
import type { CogsyncConfig } from "./config.ts";

type FiredKey = string;

export type WatchOptions = {
  config: CogsyncConfig;
  pollingSecOverride?: number;
  once?: boolean;
};

export async function runWatch(opts: WatchOptions): Promise<void> {
  const { config } = opts;
  const pollingSec = opts.pollingSecOverride ?? config.observers.ccusage.pollingSec;
  const notifier = createDesktopNotifier(config.notify.tone);
  const store = new JsonStore();
  const fired = new Set<FiredKey>();

  await notifier.notify({
    template: "watch_started",
    severity: "info",
    vars: { polling_sec: pollingSec, limit_warn_min: config.thresholds.limitWarnMin },
  });

  let stopped = false;
  const stop = (sig: NodeJS.Signals) => {
    if (stopped) return;
    stopped = true;
    console.log(`\n[cogsync] received ${sig}, stopping watch.`);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  await tick({ notifier, fired, config, store });
  if (opts.once) return;

  while (!stopped) {
    await sleep(pollingSec * 1000, () => stopped);
    if (stopped) break;
    try {
      await tick({ notifier, fired, config, store });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[cogsync] tick error: ${msg}`);
    }
  }
}

type TickArgs = {
  notifier: ReturnType<typeof createDesktopNotifier>;
  fired: Set<FiredKey>;
  config: CogsyncConfig;
  store: JsonStore;
};

async function tick({ notifier, fired, config, store }: TickArgs): Promise<void> {
  const window = await safeFetchWindow();
  const snowball = await safeSnapshotSnowball(config);
  const phaseState = store.getPhase();
  const phase = phaseState?.phase ?? "implement";

  const statusBits: string[] = [`[${nowHHMMSS()}]`];
  if (window) statusBits.push(formatStatusLine(window));
  else statusBits.push("no active 5h block");
  if (snowball.state) {
    statusBits.push(
      `| snowball ${kf(snowball.state.cumulativeTokens)}/${kf(snowball.state.threshold)}` +
        (snowball.state.triggered ? " (TRIG)" : ""),
    );
  }
  statusBits.push(`| phase=${phase}`);
  console.log(statusBits.join(" "));

  const adv: Advice = advise({
    phase,
    window,
    snowball: snowball.state,
    deepWorkAccumMin: 0, // v0.2 ではディープワーク追跡未実装、常に 0
    parallelCapacity: config.profile.parallelCapacity,
    limitWarnMin: config.thresholds.limitWarnMin,
    dailyDeepWorkCapMin: config.profile.dailyDeepWorkCapMin,
  });

  if (adv.action === "continue" || !adv.templateId) return;

  // dedup key: 5h ブロック ID か セッション ID + templateId
  const dedupBase =
    adv.templateId === "snowball_detected"
      ? snowball.sessionId ?? "no-session"
      : window?.endsAt.toISOString() ?? "no-window";
  const key: FiredKey = `${dedupBase}:${adv.templateId}`;
  if (fired.has(key)) return;
  fired.add(key);

  const req: NotifyRequest = {
    template: adv.templateId,
    severity: severityFor(adv),
    vars: adv.vars ?? {},
  };
  await notifier.notify(req);
  console.log(`  -> [${adv.action}] ${adv.rationale}`);
}

async function safeFetchWindow(): Promise<WindowStatus | null> {
  try {
    const block = await fetchActiveBlock();
    return block ? computeWindowStatus(block) : null;
  } catch (err) {
    if (err instanceof CcusageError) {
      console.error(`[cogsync] ${err.message}`);
      return null;
    }
    throw err;
  }
}

async function safeSnapshotSnowball(
  config: CogsyncConfig,
): Promise<{ state: SnowballState | null; sessionId: string | null }> {
  if (!config.observers.claudeCode.enabled) return { state: null, sessionId: null };
  try {
    const snap = snapshotRecentSessions(config.observers.claudeCode.logDir, 1);
    const top = snap[0];
    if (!top || !top.latest) return { state: null, sessionId: null };
    const { readSessionSamples } = await import("./observers/claude_code.ts");
    const samples = readSessionSamples(top.file);
    const state = detectSnowball(samples, config.thresholds.snowballToken);
    return { state, sessionId: top.file.sessionId };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[cogsync] snowball snapshot error: ${msg}`);
    return { state: null, sessionId: null };
  }
}

function severityFor(adv: Advice): "info" | "nudge" | "warn" | "critical" {
  switch (adv.templateId) {
    case "burn_exhaustion":
    case "limit_approaching":
      return "warn";
    case "snowball_detected":
      return "nudge";
    case "deepwork_cap_reached":
      return "warn";
    default:
      return "info";
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

function nowHHMMSS(): string {
  const d = new Date();
  return [d.getHours(), d.getMinutes(), d.getSeconds()]
    .map((n) => String(n).padStart(2, "0"))
    .join(":");
}

function kf(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1000)}k`;
  return String(n);
}
