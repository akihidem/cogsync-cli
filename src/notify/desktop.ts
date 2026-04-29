/**
 * notify: desktop
 * node-notifier ラッパ。テンプレ ID で発行する。
 * テンプレ本体は cogsync (調査) product/coaching-prompts.md §1。
 */

export type NotifySeverity = "info" | "nudge" | "warn" | "critical";
export type NotifyTone = "neutral" | "librarian" | "coach" | "kansai";

export type NotifyRequest = {
  template: string; // 例: "limit_approaching" / "snowball_detected"
  severity: NotifySeverity;
  vars: Record<string, string | number>;
  tone?: NotifyTone;
  actions?: string[]; // ボタン文言（クリック結果は v1.0 で扱う）
};

export interface DesktopNotifier {
  notify(req: NotifyRequest): Promise<void>;
  setQuiet(quiet: boolean): void; // AI 処理中の通知抑制用
}

export function createDesktopNotifier(_defaultTone: NotifyTone): DesktopNotifier {
  // TODO v0.1: node-notifier で OS 通知。テンプレ→文言変換は別レイヤ
  throw new Error("createDesktopNotifier not implemented (v0.1)");
}
