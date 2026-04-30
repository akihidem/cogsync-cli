/**
 * coach: phase
 *
 * 現在のフェーズ管理。MVP は手動切替のみ（v0.2）。
 * 自動判定は v0.3 以降に軽量 LLM or ヒューリスティックで。
 */

export type Phase = "design" | "implement" | "review" | "break";

export const ALL_PHASES: readonly Phase[] = ["design", "implement", "review", "break"] as const;

export type PhaseState = {
  phase: Phase;
  /** ISO 文字列 (JSON 永続化される) または Date */
  startedAt: string | Date;
};

export function isPhase(s: string): s is Phase {
  return (ALL_PHASES as readonly string[]).includes(s);
}

export function normalizeStartedAt(s: PhaseState): Date {
  return s.startedAt instanceof Date ? s.startedAt : new Date(s.startedAt);
}

/**
 * フェーズ別の推奨モデル（cogsync 本体 product/coaching-prompts.md / requirements.md CO-1 準拠）
 */
export function recommendedModelsFor(phase: Phase): string[] {
  switch (phase) {
    case "design":
      return ["claude-opus-4-7", "claude-opus-4-6"];
    case "implement":
      return ["claude-sonnet-4-6", "claude-haiku-4-5-20251001"];
    case "review":
      return ["claude-opus-4-7", "claude-sonnet-4-6"];
    case "break":
      return [];
  }
}
