/**
 * state: store
 * better-sqlite3 でローカル永続化。スキーマは docs/DESIGN.md §2.7。
 */

export type SessionRow = {
  id: string;
  tool: string;
  phase: string;
  startedAt: number;
  endedAt: number | null;
  projectId: string | null;
  parentSessionId: string | null;
};

export type TokenEventRow = {
  id?: number;
  sessionId: string;
  ts: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheCreate: number;
  model: string;
};

export type HandoffRow = {
  id: string;
  createdAt: number;
  fromSessionId: string;
  toSessionId: string | null;
  text: string;
  structured: string; // JSON
};

export interface Store {
  init(): Promise<void>;

  upsertSession(s: SessionRow): Promise<void>;
  insertTokenEvent(e: TokenEventRow): Promise<void>;
  insertHandoff(h: HandoffRow): Promise<void>;

  recentTokenEvents(sessionId: string, sinceMin: number): Promise<TokenEventRow[]>;
  todaysSessions(date: string): Promise<SessionRow[]>;

  close(): Promise<void>;
}

export function createStore(_dbPath: string): Store {
  // TODO v0.1: better-sqlite3 で実装、CREATE TABLE IF NOT EXISTS で初期化
  throw new Error("createStore not implemented (v0.1)");
}
