/**
 * observer: claude_code
 * ~/.claude/projects/**\/*.jsonl を chokidar で監視し新セッションを検知する。
 * ccusage と同じデータソースだが、こちらはイベント駆動でセッション境界を取る。
 */

export type SessionEvent =
  | { kind: "session_start"; sessionId: string; projectId: string; startedAt: Date }
  | { kind: "session_end"; sessionId: string; endedAt: Date };

export interface ClaudeCodeObserver {
  start(onEvent: (e: SessionEvent) => void): Promise<void>;
  stop(): Promise<void>;
}

// TODO v0.1: chokidar で監視。JSONL の最終行を tail で読み、session_id 切替を検出
export function createClaudeCodeObserver(_logDir: string): ClaudeCodeObserver {
  throw new Error("createClaudeCodeObserver not implemented (v0.1)");
}
