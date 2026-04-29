/**
 * observer: ccusage
 * ccusage の MCP 統合 or JSONL 直読でトークン消費を取得し UsageEvent を発行。
 * 参考: https://github.com/ryoppippi/ccusage
 */

export type UsageEvent = {
  kind: "usage";
  tool: "claude_code";
  sessionId: string;
  timestamp: Date;
  tokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheCreate: number;
  };
  model: string;
};

export type Window5hSnapshot = {
  startedAt: Date;
  endsAt: Date;
  consumedPct: number;
  estimatedExhaustionAt: Date | null;
};

export interface CcusageObserver {
  start(onEvent: (e: UsageEvent) => void): Promise<void>;
  stop(): Promise<void>;
  currentWindow(): Promise<Window5hSnapshot | null>;
}

// TODO v0.1: 実装。最初は `npx ccusage blocks --active --json` をポーリング呼び出しで OK
export function createCcusageObserver(_pollingSec: number): CcusageObserver {
  throw new Error("createCcusageObserver not implemented (v0.1)");
}
