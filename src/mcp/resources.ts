/**
 * MCP resources: cogsync の現在状態を JSON で公開する読み取り専用リソース群。
 *
 * URI 一覧 (spec §3 準拠):
 *   - cogsync://state/phase           現在のフェーズ + stale 判定 + 推奨モデル
 *   - cogsync://state/limits          ccusage 経由の 5h ウィンドウ残量
 *   - cogsync://state/deepwork        今日のディープワーク累積分 + 履歴
 *   - cogsync://state/active-session  真にアクティブなセッションのメタ
 *
 * 各 build*State() は副作用を呼び出すだけで JSON 化までを担う。テスト容易性のため
 * 依存は引数経由で注入できるようにしてあるが、CLI 起動時はデフォルトの内部呼び出しで OK。
 */

import { readFileSync } from "node:fs";
import {
  isPhaseStale,
  normalizeStartedAt,
  recommendedModelsFor,
  type Phase,
  type PhaseState,
} from "../coach/phase.ts";
import { JsonStore } from "../state/store.ts";
import type { DeepWorkBuckets, DeepWorkPersisted } from "../infer/work_state.ts";
import { fetchActiveBlockCached, CcusageError } from "../observers/ccusage.ts";
import { computeWindowStatus } from "../infer/window5h.ts";
import {
  findActiveSession,
  readSessionSamples,
} from "../observers/claude_code.ts";
import type { CogsyncConfig } from "../config.ts";

// ──────────────────────────────────────────────────────────────────────────────
// state/phase
// ──────────────────────────────────────────────────────────────────────────────

export type PhaseStatePayload = {
  phase: Phase | null;
  since: string | null;
  duration_min: number | null;
  stale: boolean;
  recommended_models: string[];
};

export function buildPhaseState(
  raw: PhaseState | null,
  staleHours: number,
  now: Date = new Date(),
): PhaseStatePayload {
  if (!raw) {
    return { phase: null, since: null, duration_min: null, stale: false, recommended_models: [] };
  }
  const startedAt = normalizeStartedAt(raw);
  const stale = isPhaseStale(raw, staleHours, now);
  return {
    phase: raw.phase,
    since: startedAt.toISOString(),
    duration_min: Math.round((now.getTime() - startedAt.getTime()) / 60000),
    stale,
    recommended_models: recommendedModelsFor(raw.phase),
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// state/limits
// ──────────────────────────────────────────────────────────────────────────────

export type LimitsPayload = {
  claude: {
    window5h: {
      started_at: string;
      ends_at: string;
      consumed_tokens: number;
      effective_remaining_min: number;
      remaining_reason: "window_end" | "burn_exhaustion";
      estimated_exhaustion_at: string | null;
      burn_rate_tokens_per_min: number | null;
      models: string[];
    } | null;
  };
};

export async function buildLimitsState(
  ttlMs: number,
  now: Date = new Date(),
): Promise<LimitsPayload> {
  try {
    const block = await fetchActiveBlockCached(ttlMs);
    if (!block) return { claude: { window5h: null } };
    const w = computeWindowStatus(block, now);
    return {
      claude: {
        window5h: {
          started_at: w.startedAt.toISOString(),
          ends_at: w.endsAt.toISOString(),
          consumed_tokens: w.consumedTokens,
          effective_remaining_min: w.effectiveRemainingMinutes,
          remaining_reason: w.remainingReason,
          estimated_exhaustion_at: w.estimatedExhaustionAt?.toISOString() ?? null,
          burn_rate_tokens_per_min: w.burnRateTokensPerMinute,
          models: w.models,
        },
      },
    };
  } catch (err) {
    if (err instanceof CcusageError) return { claude: { window5h: null } };
    throw err;
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// state/deepwork
// ──────────────────────────────────────────────────────────────────────────────

/**
 * minutes は manual+auto+bypass の総分。バケット別内訳も同梱する。
 * 旧クライアント互換のため minutes フィールドは残す。
 */
export type DeepWorkDayBreakdown = {
  date: string;
  minutes: number;
  manual: number;
  auto: number;
  bypass: number;
};
export type DeepWorkPayload = {
  today: DeepWorkDayBreakdown;
  history: Array<DeepWorkDayBreakdown>;
};

export function buildDeepWorkState(
  raw: DeepWorkPersisted | null,
  now: Date = new Date(),
): DeepWorkPayload {
  const byDate = raw?.byDate ?? {};
  const byDateBuckets = raw?.byDateBuckets ?? {};
  const todayKey = ymd(now);

  const allDates = new Set<string>([...Object.keys(byDate), ...Object.keys(byDateBuckets)]);
  const toBreakdown = (date: string): DeepWorkDayBreakdown => {
    const buckets = byDateBuckets[date];
    if (buckets) {
      const manual = Math.round((buckets.manual ?? 0) / 60000);
      const auto = Math.round((buckets.auto ?? 0) / 60000);
      const bypass = Math.round((buckets.bypass ?? 0) / 60000);
      return { date, minutes: manual + auto + bypass, manual, auto, bypass };
    }
    // 旧データ: byDate のみ。manual に寄せる。
    const m = Math.round((byDate[date] ?? 0) / 60000);
    return { date, minutes: m, manual: m, auto: 0, bypass: 0 };
  };

  const today = allDates.has(todayKey)
    ? toBreakdown(todayKey)
    : { date: todayKey, minutes: 0, manual: 0, auto: 0, bypass: 0 };
  const history = [...allDates]
    .map((date) => toBreakdown(date))
    .sort((a, b) => a.date.localeCompare(b.date));
  return { today, history };
}

function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// ──────────────────────────────────────────────────────────────────────────────
// state/active-session
// ──────────────────────────────────────────────────────────────────────────────

export type ActiveSessionPayload = {
  session_id: string;
  project: string;
  log_path: string;
  mtime: string;
  size_bytes: number;
  last_user_at: string | null;
  last_assistant_at: string | null;
  cumulative_uncached_tokens: number | null;
  resolution: "parent-pid" | "mtime-recent";
} | null;

export function buildActiveSessionState(
  config: CogsyncConfig,
  now: Date = new Date(),
): ActiveSessionPayload {
  if (!config.observers.claudeCode.enabled) return null;
  const active = findActiveSession(
    config.observers.claudeCode.logDir,
    config.thresholds.activeSessionWindowMin,
    5,
    now,
    process.ppid,
  );
  if (!active) return null;
  let cumulative: number | null = null;
  try {
    const samples = readSessionSamples(active.file);
    if (samples.length > 0) {
      cumulative = samples[samples.length - 1]!.cumulativeUncached;
    }
  } catch {
    // 読み取り失敗時は cumulative を null のまま返す
  }
  return {
    session_id: active.file.sessionId,
    project: active.file.project,
    log_path: active.file.path,
    mtime: active.file.mtime.toISOString(),
    size_bytes: active.file.sizeBytes,
    last_user_at: active.lastUserAt?.toISOString() ?? null,
    last_assistant_at: active.lastAssistantAt?.toISOString() ?? null,
    cumulative_uncached_tokens: cumulative,
    resolution: active.resolution,
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// 起動時の整合性チェック用
// ──────────────────────────────────────────────────────────────────────────────

export function readStateFile(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

// ヘルパー: store と config から各リソースの最新値を返すまとめ。CLI/server 用。
export type ResourceContext = { config: CogsyncConfig; store: JsonStore };

export function readPhaseResource(ctx: ResourceContext, now: Date = new Date()): PhaseStatePayload {
  return buildPhaseState(ctx.store.getPhase(), ctx.config.thresholds.phaseStaleHours, now);
}

export async function readLimitsResource(
  ctx: ResourceContext,
  now: Date = new Date(),
): Promise<LimitsPayload> {
  const ttlMs = Math.max(5_000, ctx.config.observers.ccusage.pollingSec * 1000 * 0.9);
  return buildLimitsState(ttlMs, now);
}

export function readDeepWorkResource(ctx: ResourceContext, now: Date = new Date()): DeepWorkPayload {
  return buildDeepWorkState(ctx.store.loadDeepWork(), now);
}

export function readActiveSessionResource(
  ctx: ResourceContext,
  now: Date = new Date(),
): ActiveSessionPayload {
  return buildActiveSessionState(ctx.config, now);
}
