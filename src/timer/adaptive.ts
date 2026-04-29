/**
 * timer: adaptive
 * 適応的ポモドーロ。AI 処理イベント中はブレイクを延長／集中時間を継続。
 * 仕様: cogsync (調査) product/requirements.md TI-1。
 */

export type TimerKind = "pomodoro" | "deep_break" | "ai_wait";

export type TimerHandle = {
  id: string;
  kind: TimerKind;
  startedAt: Date;
  endsAt: Date;
  cancel(): void;
};

// TODO v0.3: AI 処理イベント（observers から）を購読し、kind に応じて伸縮
export function startTimer(_kind: TimerKind, _durationSec?: number): TimerHandle {
  throw new Error("startTimer not implemented (v0.3)");
}
