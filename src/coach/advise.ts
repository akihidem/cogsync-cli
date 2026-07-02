/**
 * coach: advise
 *
 * 推論結果から「いま何をすべきか」を 1 つ選ぶルールベース判定。
 * 詳細は cogsync 本体 product/coaching-prompts.md §3.3。
 */

import type { Phase } from "./phase.ts";
import type { WindowStatus } from "../infer/window5h.ts";
import type { SnowballState } from "../infer/snowball.ts";
import type { WorkState } from "../infer/work_state.ts";
import { formatWeekdayHHMM, type WeeklyStatus } from "../infer/weekly.ts";

export type Advice = {
  action:
    | "continue"
    | "create_handoff"
    | "take_break"
    | "switch_model"
    | "stop_for_today"
    | "throttle_batch";
  rationale: string;
  confidence: number;
  /** notify テンプレ ID（必要時のみ） */
  templateId?:
    | "snowball_detected"
    | "limit_approaching"
    | "burn_exhaustion"
    | "deepwork_cap_reached"
    | "deep_break_suggested"
    | "weekly_pace_exceeded";
  /** notify テンプレに渡す変数 */
  vars?: Record<string, string | number>;
};

export type AdviseInput = {
  phase: Phase;
  window: WindowStatus | null;
  snowball: SnowballState | null;
  workState: WorkState;
  /** ai_busy が継続している分数（active/idle 時は 0） */
  aiBusyDurationMin: number;
  /** 当日のディープワーク総分（manual + auto + bypass）。表示用。 */
  deepWorkAccumMin: number;
  /**
   * 当日の manual バケット分。permissionMode=default 下での累積。
   * 「人間が判断していた時間」の近似で、cap 判定はこちらを使う。
   * 未指定なら deepWorkAccumMin にフォールバック（後方互換）。
   */
  deepWorkManualMin?: number;
  parallelCapacity: number;
  /** 設定: limit 警告閾値 */
  limitWarnMin: number;
  /** 設定: ディープワーク日次上限 */
  dailyDeepWorkCapMin: number;
  /** 設定: ai_busy がこの分以上ならブレイク提案 */
  aiWaitBreakMin: number;
  /** 週次 pacing（statusline snapshot 由来）。未取得や sevenDay 欠落時は null */
  weekly?: WeeklyStatus | null;
};

export function advise(input: AdviseInput): Advice {
  // 優先順位 1: 雪だるま検出（コンテキスト膨張）
  if (input.snowball?.triggered) {
    return {
      action: "create_handoff",
      rationale: `セッション内コンテキストが ${kf(input.snowball.cumulativeTokens)} に達した（閾値 ${kf(input.snowball.threshold)}）。Lost-in-the-middle のリスクあり。`,
      confidence: 0.9,
      templateId: "snowball_detected",
      vars: {
        cumulative_kt: Math.round(input.snowball.cumulativeTokens / 1000),
        threshold_kt: Math.round(input.snowball.threshold / 1000),
      },
    };
  }

  // 優先順位 2: リミット枯渇接近
  if (input.window && input.window.effectiveRemainingMinutes <= input.limitWarnMin) {
    if (input.window.remainingReason === "burn_exhaustion") {
      return {
        action: "create_handoff",
        rationale: `現バーンレートだと ${input.window.effectiveRemainingMinutes} 分で枯渇予測（ウィンドウ終了より早い）。`,
        confidence: 0.85,
        templateId: "burn_exhaustion",
        vars: {
          minutes_to_exhaustion: input.window.effectiveRemainingMinutes,
          window_end_hhmm: hhmm(input.window.endsAt),
        },
      };
    }
    return {
      action: "create_handoff",
      rationale: `5h ウィンドウ残り ${input.window.effectiveRemainingMinutes} 分。セッションを切ってハンドオフ推奨。`,
      confidence: 0.85,
      templateId: "limit_approaching",
      vars: {
        remaining_min: input.window.effectiveRemainingMinutes,
      },
    };
  }

  // 優先順位 3: 週次 red（予算線超過）
  // stale な snapshot は判定材料として信用しない（うるさいコーチ禁止と同じ理由で
  // 古いデータに基づく誤発火を避ける）。yellow は通知しない（continue に落とす）。
  const weekly = input.weekly;
  if (weekly && !weekly.stale && weekly.level === "red") {
    const sign = weekly.paceDeltaPct >= 0 ? "+" : "";
    const paceDeltaPt = Math.round(weekly.paceDeltaPct * 10) / 10;
    const budgetLinePct = Math.round(weekly.budgetLinePct * 10) / 10;
    const usedPct = Math.round(weekly.usedPct * 10) / 10;
    const exhaustionAt = weekly.projectedExhaustionAt ? formatWeekdayHHMM(weekly.projectedExhaustionAt) : null;
    // red には 2 経路ある: 予算線超過(pace) と 100% 到達(cap)。
    // cap 到達時に「+0pt 超過」と言うのは不正確なので文言を分ける。
    const capReached = weekly.usedPct >= 100;
    return {
      action: "throttle_batch",
      rationale: capReached
        ? `週次枠を使い切りました（消費 ${usedPct}%）。リセットまで自律バッチは停止し、対話は最小限に。`
        : `週次消費が予算線を ${sign}${paceDeltaPt}pt 超過（予算線 ${budgetLinePct}% / 消費 ${usedPct}%）。` +
          (exhaustionAt ? `このままだと ${exhaustionAt} に枯渇。` : ""),
      confidence: 0.8,
      templateId: "weekly_pace_exceeded",
      vars: {
        reason: capReached ? "cap_reached" : "pace_exceeded",
        pace_delta_pt: paceDeltaPt,
        budget_line_pct: budgetLinePct,
        used_pct: usedPct,
        projected_exhaustion_at: exhaustionAt ?? "",
      },
    };
  }

  // 優先順位 4: ディープワーク日次上限到達
  // cap 判定は manual バケットのみで行う（auto/bypass は AI に丸投げの時間なので
  // 認知負荷が低い前提）。manual が未指定なら従来通り total を使う。
  const capMin = input.deepWorkManualMin ?? input.deepWorkAccumMin;
  if (capMin >= input.dailyDeepWorkCapMin) {
    return {
      action: "stop_for_today",
      rationale: `今日の判断系ディープワーク ${capMin} 分が上限 ${input.dailyDeepWorkCapMin} 分に到達。これ以上は精度が落ちやすい。`,
      confidence: 0.7,
      templateId: "deepwork_cap_reached",
      vars: {
        accumulated_min: capMin,
        total_min: input.deepWorkAccumMin,
        daily_cap_min: input.dailyDeepWorkCapMin,
      },
    };
  }

  // 優先順位 5: AI 処理中の長時間待機 → ブレイク推奨 (CO-5)
  if (input.workState === "ai_busy" && input.aiBusyDurationMin >= input.aiWaitBreakMin) {
    return {
      action: "take_break",
      rationale: `AI 処理待ち ${input.aiBusyDurationMin} 分継続中。今のうちに席を立つのが効率的。`,
      confidence: 0.75,
      templateId: "deep_break_suggested",
      vars: {
        ai_busy_min: input.aiBusyDurationMin,
        suggested_break_min: Math.max(5, input.aiBusyDurationMin),
      },
    };
  }

  return {
    action: "continue",
    rationale: `フェーズ ${input.phase}、リミット余裕あり、雪だるまなし。継続可。`,
    confidence: 0.5,
  };
}

function hhmm(d: Date): string {
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function kf(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`;
  return String(n);
}
