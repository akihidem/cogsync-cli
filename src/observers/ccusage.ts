/**
 * observer: ccusage
 * `npx -y ccusage@latest blocks --active --json` を子プロセスで叩いて
 * アクティブな 5h ブロックのスナップショットを取得する。
 *
 * 参考: https://github.com/ryoppippi/ccusage
 *
 * v0.1: 子プロセス呼び出しのワンショット実装。常駐ポーリングと MCP 経由は v0.2。
 */

import { spawn } from "node:child_process";

export type Window5hBlock = {
  id: string;
  startTime: Date;
  endTime: Date;
  actualEndTime: Date;
  isActive: boolean;
  isGap: boolean;
  entries: number;
  tokenCounts: {
    inputTokens: number;
    outputTokens: number;
    cacheCreationInputTokens: number;
    cacheReadInputTokens: number;
  };
  totalTokens: number;
  costUSD: number;
  models: string[];
  burnRate: {
    tokensPerMinute: number;
    /** 表示用に丸めた値。リミット予測には projection.remainingMinutes を優先 */
    tokensPerMinuteForIndicator: number;
    costPerHour: number;
  } | null;
  projection: {
    /** ウィンドウ終了時刻までこの burnRate で使った場合の累計トークン */
    totalTokens: number;
    totalCost: number;
    /** ウィンドウ終了までの残り分数（ccusage の計算ベース） */
    remainingMinutes: number;
  } | null;
};

type RawBlock = {
  id: string;
  startTime: string;
  endTime: string;
  actualEndTime?: string;
  isActive: boolean;
  isGap?: boolean;
  entries: number;
  tokenCounts: {
    inputTokens: number;
    outputTokens: number;
    cacheCreationInputTokens: number;
    cacheReadInputTokens: number;
  };
  totalTokens: number;
  costUSD: number;
  models: string[];
  burnRate?: {
    tokensPerMinute: number;
    tokensPerMinuteForIndicator: number;
    costPerHour: number;
  };
  projection?: {
    totalTokens: number;
    totalCost: number;
    remainingMinutes: number;
  };
};

type RawResponse = {
  blocks: RawBlock[];
};

export class CcusageError extends Error {
  public override readonly cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "CcusageError";
    this.cause = cause;
  }
}

/**
 * `npx ccusage` を 1 回呼び出し、アクティブブロックを返す。
 * アクティブブロックが無ければ null。
 *
 * NOTE: 起動コストが 1〜3 秒あるため、watch ループではキャッシュ版
 * fetchActiveBlockCached を使う。
 */
export async function fetchActiveBlock(timeoutMs = 30000): Promise<Window5hBlock | null> {
  const raw = await runCcusage(["blocks", "--active", "--json"], timeoutMs);
  const parsed = parseResponse(raw);
  const active = parsed.blocks.find((b) => b.isActive && !b.isGap);
  if (!active) return null;
  return normalizeBlock(active);
}

type CacheEntry = {
  fetchedAt: number; // epoch ms
  value: Window5hBlock | null;
};

let cache: CacheEntry | null = null;
let inFlight: Promise<Window5hBlock | null> | null = null;

/**
 * TTL 付きキャッシュ + in-flight dedup 版。
 * watch ループの 30 秒ポーリングで使うことを想定。
 *
 * - 直近 ttlMs 以内ならキャッシュを返す
 * - キャッシュ切れ時の同時呼び出しは 1 つの fetch にまとめる
 */
export async function fetchActiveBlockCached(
  ttlMs: number,
  timeoutMs = 30000,
): Promise<Window5hBlock | null> {
  const now = Date.now();
  if (cache && now - cache.fetchedAt < ttlMs) {
    return cache.value;
  }
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const v = await fetchActiveBlock(timeoutMs);
      cache = { fetchedAt: Date.now(), value: v };
      return v;
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

/** テスト用 / status コマンドからの強制再取得用 */
export function invalidateCcusageCache(): void {
  cache = null;
}

/**
 * 過去全ブロックを取得（gap 除外なし、呼び出し側で判断）。
 * バックテスト用。
 */
export async function fetchAllBlocks(timeoutMs = 60000): Promise<Window5hBlock[]> {
  const raw = await runCcusage(["blocks", "--json"], timeoutMs);
  const parsed = parseResponse(raw);
  return parsed.blocks.map(normalizeBlock);
}

function runCcusage(args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("npx", ["-y", "ccusage@latest", ...args], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new CcusageError(`ccusage timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new CcusageError(`failed to spawn ccusage: ${err.message}`, err));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new CcusageError(`ccusage exited ${code}: ${stderr.trim()}`));
        return;
      }
      resolve(stdout);
    });
  });
}

function parseResponse(text: string): RawResponse {
  // ccusage の出力には ANSI 装飾が混じることがある。最初の `{` から末尾まで取り出す
  const start = text.indexOf("{");
  if (start < 0) throw new CcusageError(`no JSON object in ccusage output: ${text.slice(0, 200)}`);
  const json = text.slice(start);
  try {
    return JSON.parse(json) as RawResponse;
  } catch (err) {
    throw new CcusageError(`failed to parse ccusage JSON`, err);
  }
}

function normalizeBlock(b: RawBlock): Window5hBlock {
  return {
    id: b.id,
    startTime: new Date(b.startTime),
    endTime: new Date(b.endTime),
    actualEndTime: new Date(b.actualEndTime ?? b.startTime),
    isActive: b.isActive,
    isGap: b.isGap ?? false,
    entries: b.entries,
    tokenCounts: b.tokenCounts,
    totalTokens: b.totalTokens,
    costUSD: b.costUSD,
    models: b.models,
    burnRate: b.burnRate ?? null,
    projection: b.projection ?? null,
  };
}
