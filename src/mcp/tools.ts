/**
 * MCP tools: cogsync の状態を変更するアクション群。
 *
 * v1.0 で提供する 3 Tool:
 *   - set_phase          フェーズ切替（design/implement/review/break）
 *   - get_recommended_action  現在の状態からルールベースで推奨アクションを返す
 *   - create_handoff     ハンドオフ・プロンプトを生成
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ALL_PHASES, isPhaseStale, type Phase } from "../coach/phase.ts";
import { advise, type AdviseInput } from "../coach/advise.ts";
import { renderStandard } from "../handoff/template.ts";
import { fetchActiveBlockCached, CcusageError } from "../observers/ccusage.ts";
import { computeWindowStatus, type WindowStatus } from "../infer/window5h.ts";
import { findActiveSession, readSessionSamples } from "../observers/claude_code.ts";
import { detectSnowball } from "../infer/snowball.ts";
import { classifyWorkState } from "../infer/work_state.ts";
import type { ResourceContext } from "./resources.ts";

export function registerTools(server: McpServer, ctx: ResourceContext): void {
  // ─── set_phase ───────────────────────────────────────────────────────────────
  server.registerTool(
    "set_phase",
    {
      title: "フェーズ切替",
      description:
        "作業フェーズを切り替える。design（設計）/ implement（実装）/ review（レビュー）/ break（休憩）のいずれか。",
      inputSchema: {
        phase: z.enum(["design", "implement", "review", "break"]).describe("切り替え先のフェーズ"),
        reason: z.string().optional().describe("切替の理由（任意）"),
      },
      annotations: { destructiveHint: false, readOnlyHint: false },
    },
    (args) => {
      const prev = ctx.store.getPhase();
      const newPhase = args.phase as Phase;
      ctx.store.setPhase(newPhase);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              ok: true,
              previous_phase: prev?.phase ?? null,
              new_phase: newPhase,
            }),
          },
        ],
      };
    },
  );

  // ─── get_recommended_action ──────────────────────────────────────────────────
  server.registerTool(
    "get_recommended_action",
    {
      title: "推奨アクション取得",
      description:
        "現在の状態（フェーズ・リミット残量・コンテキスト膨張・ディープワーク累積）を総合し、いま何をすべきかをルールベースで判定して返す。",
      inputSchema: {},
      annotations: { destructiveHint: false, readOnlyHint: true },
    },
    async () => {
      const input = await buildAdviseInput(ctx);
      const result = advise(input);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              action: result.action,
              rationale: result.rationale,
              confidence: result.confidence,
            }),
          },
        ],
      };
    },
  );

  // ─── create_handoff ──────────────────────────────────────────────────────────
  server.registerTool(
    "create_handoff",
    {
      title: "ハンドオフ生成",
      description:
        "セッション間のコンテキスト引継ぎ用ハンドオフ・プロンプトを生成する。goal / state / nextAction は必須。",
      inputSchema: {
        goal: z.string().describe("達成目標"),
        state: z.string().describe("現在の進捗状況"),
        nextAction: z.string().describe("次のアクション"),
        decisions: z.array(z.string()).optional().describe("確定した判断事項"),
        openQuestions: z.array(z.string()).optional().describe("未解決の問い"),
        title: z.string().optional().describe("ハンドオフのタイトル"),
      },
      annotations: { destructiveHint: false, readOnlyHint: true },
    },
    (args) => {
      const struct = {
        goal: args.goal,
        state: args.state,
        nextAction: args.nextAction,
        decisions: args.decisions ?? [],
        openQuestions: args.openQuestions ?? [],
      };
      const output = renderStandard(struct, args.title);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(output),
          },
        ],
      };
    },
  );
}

// ─── ヘルパー: 現在の状態から AdviseInput を組み立てる ──────────────────────────

async function buildAdviseInput(ctx: ResourceContext): Promise<AdviseInput> {
  const { config, store } = ctx;
  const now = new Date();

  // 1. 5h ウィンドウ
  const window = await safeFetchWindow(config.observers.ccusage.pollingSec);

  // 2. アクティブセッション → snowball, workState
  const sessionInfo = safeReadLatestSession(config);
  const snowball = sessionInfo
    ? detectSnowball(
        readSessionSamples(sessionInfo.file),
        config.thresholds.snowballToken,
        config.thresholds.snowballMinTurns,
      )
    : null;
  const ws = sessionInfo
    ? classifyWorkState(sessionInfo.lastUserAt, sessionInfo.lastAssistantAt, now)
    : { state: "idle" as const, lastUserAt: null, lastAssistantAt: null, reason: "no session" };

  // 3. ai_busy 継続時間（MCP 呼び出し時点のスナップショットなので簡易推定）
  const aiBusyDurationMin =
    ws.state === "ai_busy" && ws.lastUserAt
      ? Math.max(0, (now.getTime() - ws.lastUserAt.getTime()) / 60000)
      : 0;

  // 4. フェーズ
  const phaseState = store.getPhase();
  const phaseExpired =
    phaseState != null && isPhaseStale(phaseState, config.thresholds.phaseStaleHours, now);
  const phase: Phase = phaseState && !phaseExpired ? phaseState.phase : "implement";

  // 5. ディープワーク累積（バケット別）
  const dwRaw = store.loadDeepWork();
  const todayKey = ymd(now);
  const buckets = dwRaw?.byDateBuckets?.[todayKey];
  let manualMs = 0;
  let totalMs = 0;
  if (buckets) {
    manualMs = buckets.manual ?? 0;
    totalMs = (buckets.manual ?? 0) + (buckets.auto ?? 0) + (buckets.bypass ?? 0);
  } else {
    // 旧データのみ: byDate (number) を manual に寄せる
    const legacy = dwRaw?.byDate?.[todayKey] ?? 0;
    manualMs = legacy;
    totalMs = legacy;
  }
  const deepWorkAccumMin = Math.round(totalMs / 60000);
  const deepWorkManualMin = Math.round(manualMs / 60000);

  return {
    phase,
    window,
    snowball,
    workState: ws.state,
    aiBusyDurationMin: Math.round(aiBusyDurationMin * 10) / 10,
    deepWorkAccumMin,
    deepWorkManualMin,
    parallelCapacity: config.profile.parallelCapacity,
    limitWarnMin: config.thresholds.limitWarnMin,
    dailyDeepWorkCapMin: config.profile.dailyDeepWorkCapMin,
    aiWaitBreakMin: config.thresholds.aiWaitBreakMin,
  };
}

async function safeFetchWindow(pollingSec: number): Promise<WindowStatus | null> {
  const ttlMs = Math.max(5_000, pollingSec * 1000 * 0.9);
  try {
    const block = await fetchActiveBlockCached(ttlMs);
    return block ? computeWindowStatus(block) : null;
  } catch (err) {
    if (err instanceof CcusageError) return null;
    throw err;
  }
}

function safeReadLatestSession(config: ResourceContext["config"]) {
  if (!config.observers.claudeCode.enabled) return null;
  try {
    return findActiveSession(
      config.observers.claudeCode.logDir,
      config.thresholds.activeSessionWindowMin,
    );
  } catch {
    return null;
  }
}

function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
