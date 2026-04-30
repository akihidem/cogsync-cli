/**
 * watch: 常駐ループ (v0.3)
 *
 * 観測:
 *   - ccusage 5h ブロック (TTL キャッシュ)
 *   - raw JSONL の最新 user/assistant タイムスタンプ
 * 推論:
 *   - WindowStatus (残量/枯渇予測)
 *   - SnowballState (コンテキスト膨張)
 *   - WorkState (ai_busy / active / idle)
 *   - DeepWorkAccumulator (当日累積分)
 * 指南:
 *   - advise() ルールベース、優先順位: snowball > 残量 > 上限到達 > ブレイク提案
 *
 * 通知 dedup: (sessionId or block.id) + templateId
 */

import { fetchActiveBlockCached, CcusageError } from "./observers/ccusage.ts";
import { computeWindowStatus, formatStatusLine, type WindowStatus } from "./infer/window5h.ts";
import {
  snapshotRecentSessions,
  readSessionSamples,
  readLastEventTimestamps,
  type SessionFile,
} from "./observers/claude_code.ts";
import { detectSnowball, type SnowballState } from "./infer/snowball.ts";
import { classifyWorkState, DeepWorkAccumulator, type WorkState } from "./infer/work_state.ts";
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
  const accum = new DeepWorkAccumulator();
  accum.loadFromJSON(store.loadDeepWork());
  const fired = new Set<FiredKey>();
  let aiBusySince: Date | null = null;
  let lastSavedAt = 0;

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
    // 終了前に保存
    store.saveDeepWork(accum.toJSON());
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  const ctx = { notifier, fired, config, store, accum };
  const result = await tick(ctx, aiBusySince);
  aiBusySince = result.aiBusySince;
  if (opts.once) {
    store.saveDeepWork(accum.toJSON());
    return;
  }

  while (!stopped) {
    await sleep(pollingSec * 1000, () => stopped);
    if (stopped) break;
    try {
      const r = await tick(ctx, aiBusySince);
      aiBusySince = r.aiBusySince;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[cogsync] tick error: ${msg}`);
    }
    // 1 分に 1 回 deepWork を永続化
    if (Date.now() - lastSavedAt > 60_000) {
      store.saveDeepWork(accum.toJSON());
      lastSavedAt = Date.now();
    }
  }
}

type Ctx = {
  notifier: ReturnType<typeof createDesktopNotifier>;
  fired: Set<FiredKey>;
  config: CogsyncConfig;
  store: JsonStore;
  accum: DeepWorkAccumulator;
};

async function tick(ctx: Ctx, aiBusySince: Date | null): Promise<{ aiBusySince: Date | null }> {
  const { config, store, accum, fired, notifier } = ctx;
  const pollingSec = config.observers.ccusage.pollingSec;

  const window = await safeFetchWindow(pollingSec);

  const sessionInfo = safeReadLatestSession(config);
  const snowball = sessionInfo
    ? detectSnowball(readSessionSamples(sessionInfo.file), config.thresholds.snowballToken)
    : null;

  const now = new Date();
  const ws = sessionInfo
    ? classifyWorkState(sessionInfo.lastUserAt, sessionInfo.lastAssistantAt, now)
    : { state: "idle" as WorkState, lastUserAt: null, lastAssistantAt: null, reason: "no session" };

  // ai_busy 起算時刻の更新
  let nextAiBusySince: Date | null;
  if (ws.state === "ai_busy") {
    nextAiBusySince = aiBusySince ?? ws.lastUserAt ?? now;
  } else {
    nextAiBusySince = null;
  }
  const aiBusyDurationMin = nextAiBusySince
    ? Math.max(0, (now.getTime() - nextAiBusySince.getTime()) / 60000)
    : 0;

  // ディープワーク累積
  accum.feed(ws.state, now);
  const deepWorkMin = accum.todayMin(now);

  const phaseState = store.getPhase();
  const phase = phaseState?.phase ?? "implement";

  // status 行
  const statusBits: string[] = [`[${nowHHMMSS()}]`];
  if (window) statusBits.push(formatStatusLine(window));
  else statusBits.push("no active 5h block");
  if (snowball) {
    statusBits.push(
      `| snowball ${kf(snowball.cumulativeTokens)}/${kf(snowball.threshold)}` +
        (snowball.triggered ? " (TRIG)" : ""),
    );
  }
  statusBits.push(`| ws=${ws.state}` + (aiBusyDurationMin > 0 ? `(${aiBusyDurationMin.toFixed(1)}m)` : ""));
  statusBits.push(`| dw=${deepWorkMin}m`);
  statusBits.push(`| phase=${phase}`);
  console.log(statusBits.join(" "));

  const adv: Advice = advise({
    phase,
    window,
    snowball,
    workState: ws.state,
    aiBusyDurationMin: Math.round(aiBusyDurationMin * 10) / 10,
    deepWorkAccumMin: deepWorkMin,
    parallelCapacity: config.profile.parallelCapacity,
    limitWarnMin: config.thresholds.limitWarnMin,
    dailyDeepWorkCapMin: config.profile.dailyDeepWorkCapMin,
    aiWaitBreakMin: config.thresholds.aiWaitBreakMin,
  });

  if (adv.action === "continue" || !adv.templateId) {
    return { aiBusySince: nextAiBusySince };
  }

  const dedupBase = pickDedupKey(adv, sessionInfo, window);
  const key: FiredKey = `${dedupBase}:${adv.templateId}`;
  if (fired.has(key)) return { aiBusySince: nextAiBusySince };
  fired.add(key);

  const req: NotifyRequest = {
    template: adv.templateId,
    severity: severityFor(adv),
    vars: adv.vars ?? {},
  };
  await notifier.notify(req);
  console.log(`  -> [${adv.action}] ${adv.rationale}`);

  return { aiBusySince: nextAiBusySince };
}

function pickDedupKey(
  adv: Advice,
  sessionInfo: { file: SessionFile } | null,
  window: WindowStatus | null,
): string {
  if (adv.templateId === "snowball_detected" || adv.templateId === "deep_break_suggested") {
    return sessionInfo?.file.sessionId ?? "no-session";
  }
  if (adv.templateId === "deepwork_cap_reached") {
    return new Date().toISOString().slice(0, 10); // 1 日 1 回
  }
  return window?.endsAt.toISOString() ?? "no-window";
}

async function safeFetchWindow(pollingSec: number): Promise<WindowStatus | null> {
  const ttlMs = Math.max(5_000, pollingSec * 1000 * 0.9);
  try {
    const block = await fetchActiveBlockCached(ttlMs);
    return block ? computeWindowStatus(block) : null;
  } catch (err) {
    if (err instanceof CcusageError) {
      console.error(`[cogsync] ${err.message}`);
      return null;
    }
    throw err;
  }
}

function safeReadLatestSession(config: CogsyncConfig): {
  file: SessionFile;
  lastUserAt: Date | null;
  lastAssistantAt: Date | null;
} | null {
  if (!config.observers.claudeCode.enabled) return null;
  try {
    const snap = snapshotRecentSessions(config.observers.claudeCode.logDir, 1);
    const top = snap[0];
    if (!top) return null;
    const ts = readLastEventTimestamps(top.file);
    return { file: top.file, lastUserAt: ts.lastUserAt, lastAssistantAt: ts.lastAssistantAt };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[cogsync] safeReadLatestSession: ${msg}`);
    return null;
  }
}

function severityFor(adv: Advice): "info" | "nudge" | "warn" | "critical" {
  switch (adv.templateId) {
    case "burn_exhaustion":
    case "limit_approaching":
      return "warn";
    case "snowball_detected":
    case "deep_break_suggested":
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
