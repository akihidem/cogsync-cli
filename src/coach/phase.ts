/**
 * coach: phase
 * 現在のフェーズ管理。MVP は手動切替のみ。v0.3 で軽量 LLM による自動判定を任意で。
 */

export type Phase = "design" | "implement" | "review" | "break";

export type PhaseState = {
  phase: Phase;
  startedAt: Date;
};

// TODO v0.2: state/store と連携して永続化
export function setPhase(_phase: Phase, _now: Date): PhaseState {
  throw new Error("setPhase not implemented (v0.2)");
}

export function getPhase(): PhaseState {
  throw new Error("getPhase not implemented (v0.2)");
}
