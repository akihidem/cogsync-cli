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
  findActiveSession,
  readSessionSamples,
  type SessionFile,
} from "./observers/claude_code.ts";
import { detectSnowball, type SnowballState } from "./infer/snowball.ts";
import {
  classifyWorkState,
  DeepWorkAccumulator,
  type PermissionBucket,
  type WorkState,
} from "./infer/work_state.ts";
import { advise, type Advice } from "./coach/advise.ts";
import { createDesktopNotifier, type NotifyRequest } from "./notify/desktop.ts";
import { JsonStore, defaultStatePath } from "./state/store.ts";
import { isPhaseStale } from "./coach/phase.ts";
import type { CogsyncConfig } from "./config.ts";
import { dirname, join } from "node:path";
import { acquireSingleInstanceLock } from "./util/singleton-lock.ts";
import { readSnapshot } from "./observers/statusline_snapshot.ts";
import { computeWeeklyStatus, type RateLimitSnapshot, type WeeklyStatus } from "./infer/weekly.ts";

type FiredKey = string;

export type WatchOptions = {
  config: CogsyncConfig;
  pollingSecOverride?: number;
  once?: boolean;
};

export async function runWatch(opts: WatchOptions): Promise<void> {
  const { config } = opts;
  // 常駐モードは 1 マシン 1 本に制限する（--once 診断は対象外）。起動方法（bashrc /
  // systemd / 手動）に依らず、多重起動による deepwork 二重計上・通知重複を防ぐため、
  // watch 本体で O_EXCL pidfile ロックを取る。
  if (!opts.once) {
    const lockPath = join(dirname(defaultStatePath()), "watch.lock");
    if (!acquireSingleInstanceLock(lockPath)) {
      console.error("[cogsync] 別の cogsync watch が既に稼働中のため終了します（多重起動防止）。");
      return;
    }
  }
  const pollingSec = opts.pollingSecOverride ?? config.observers.ccusage.pollingSec;
  const notifier = createDesktopNotifier(config.notify.tone);
  const store = new JsonStore();
  const accum = new DeepWorkAccumulator();
  accum.loadFromJSON(store.loadDeepWork());
  const fired = new Set<FiredKey>();
  /**
   * テンプレート ID 単位のグローバル cooldown。session pivot で fired キーが別物に
   * 化けても、同じ templateId は cooldown 期間内に再通知しない。
   */
  const lastFiredAtByTemplate = new Map<string, number>();
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

  const ctx = { notifier, fired, lastFiredAtByTemplate, config, store, accum };
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
  lastFiredAtByTemplate: Map<string, number>;
  config: CogsyncConfig;
  store: JsonStore;
  accum: DeepWorkAccumulator;
};

async function tick(ctx: Ctx, aiBusySince: Date | null): Promise<{ aiBusySince: Date | null }> {
  const { config, store, accum, fired, lastFiredAtByTemplate, notifier } = ctx;
  const pollingSec = config.observers.ccusage.pollingSec;

  const window = await safeFetchWindow(pollingSec);

  const sessionInfo = safeReadLatestSession(config);
  const snowball = sessionInfo
    ? detectSnowball(
        readSessionSamples(sessionInfo.file),
        config.thresholds.snowballToken,
        config.thresholds.snowballMinTurns,
      )
    : null;

  const now = new Date();
  const ws = sessionInfo
    ? classifyWorkState(sessionInfo.lastUserAt, sessionInfo.lastAssistantAt, now)
    : { state: "idle" as WorkState, lastUserAt: null, lastAssistantAt: null, reason: "no session" };
  const bucket: PermissionBucket = sessionInfo?.currentPermissionMode ?? "manual";

  // 週次 pacing（statusline snapshot 由来。statusLine フック未設定なら snap=null で weekly も null）
  const snap = safeReadSnapshot();
  const weekly = snap
    ? computeWeeklyStatus(snap, now, {
        redMarginPct: config.thresholds.weeklyRedMarginPct,
        staleAfterMin: config.thresholds.weeklySnapshotStaleMin,
      })
    : null;

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

  // ディープワーク累積（permissionMode バケット別に分配）
  accum.feed(ws.state, now, bucket);
  const dwBreakdown = accum.todayBreakdown(now);
  const deepWorkMin = dwBreakdown.total;

  const phaseState = store.getPhase();
  const phaseExpired =
    phaseState != null && isPhaseStale(phaseState, config.thresholds.phaseStaleHours, now);
  const phase = phaseState && !phaseExpired ? phaseState.phase : "implement";

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
  statusBits.push(
    `| dw=${deepWorkMin}m(M:${dwBreakdown.manual}/A:${dwBreakdown.auto}/B:${dwBreakdown.bypass})`,
  );
  statusBits.push(`| mode=${bucket}`);
  statusBits.push(`| phase=${phase}${phaseExpired ? "(stale→default)" : ""}`);
  console.log(statusBits.join(" "));

  const adv: Advice = advise({
    phase,
    window,
    snowball,
    workState: ws.state,
    aiBusyDurationMin: Math.round(aiBusyDurationMin * 10) / 10,
    deepWorkAccumMin: deepWorkMin,
    deepWorkManualMin: dwBreakdown.manual,
    parallelCapacity: config.profile.parallelCapacity,
    limitWarnMin: config.thresholds.limitWarnMin,
    dailyDeepWorkCapMin: config.profile.dailyDeepWorkCapMin,
    aiWaitBreakMin: config.thresholds.aiWaitBreakMin,
    weekly,
  });

  if (adv.action === "continue" || !adv.templateId) {
    return { aiBusySince: nextAiBusySince };
  }

  const dedupBase = pickDedupKey(adv, sessionInfo, window, weekly);
  const key: FiredKey = `${dedupBase}:${adv.templateId}`;
  if (fired.has(key)) return { aiBusySince: nextAiBusySince };

  // グローバル cooldown: dedupBase が pivot しても、同じ templateId は cooldown 内なら抑制
  const cooldownMs = config.thresholds.notifyCooldownMin * 60_000;
  if (cooldownMs > 0) {
    const lastAt = lastFiredAtByTemplate.get(adv.templateId);
    if (lastAt != null && now.getTime() - lastAt < cooldownMs) {
      return { aiBusySince: nextAiBusySince };
    }
  }

  fired.add(key);
  lastFiredAtByTemplate.set(adv.templateId, now.getTime());

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
  weekly: WeeklyStatus | null,
): string {
  if (adv.templateId === "snowball_detected" || adv.templateId === "deep_break_suggested") {
    return sessionInfo?.file.sessionId ?? "no-session";
  }
  if (adv.templateId === "deepwork_cap_reached") {
    return new Date().toISOString().slice(0, 10); // 1 日 1 回
  }
  if (adv.templateId === "weekly_pace_exceeded") {
    return weekly?.resetsAt.toISOString() ?? "no-weekly"; // 週次ウィンドウ単位
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
  currentPermissionMode: PermissionBucket;
} | null {
  if (!config.observers.claudeCode.enabled) return null;
  try {
    return findActiveSession(
      config.observers.claudeCode.logDir,
      config.thresholds.activeSessionWindowMin,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[cogsync] safeReadLatestSession: ${msg}`);
    return null;
  }
}

function safeReadSnapshot(): RateLimitSnapshot | null {
  try {
    return readSnapshot();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[cogsync] safeReadSnapshot: ${msg}`);
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
    case "weekly_pace_exceeded":
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
