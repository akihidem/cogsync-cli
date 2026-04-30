/**
 * coach: advise
 * フェーズ・残量・スキルプロファイルから推奨アクションを 1 つ選ぶ判断エンジン。
 * 詳細ロジックは cogsync (調査) product/coaching-prompts.md §3.3。
 */

import type { Phase } from "./phase.ts";
import type { WindowStatus } from "../infer/window5h.ts";

export type Advice = {
  action:
    | "continue"
    | "switch_session"
    | "take_break"
    | "switch_model"
    | "stop_for_today"
    | "create_handoff";
  rationale: string;
  confidence: number; // 0..1
  templateId?: string; // notify テンプレ ID
};

export type AdviseInput = {
  phase: Phase;
  window: WindowStatus | null;
  deepWorkAccumMin: number;
  parallelCapacity: number;
  snowballTriggered: boolean;
};

export function advise(_input: AdviseInput): Advice {
  // TODO v0.2: ルールベース実装。優先順位:
  //   1. snowballTriggered  -> create_handoff (templateId: snowball_detected)
  //   2. minutesRemaining < 15 && phase === "implement" -> create_handoff (limit_approaching)
  //   3. deepWorkAccumMin >= cap -> stop_for_today
  //   4. phase === "review" && minutesRemaining < 5 -> switch_session
  //   5. else -> continue
  throw new Error("advise not implemented (v0.2)");
}
