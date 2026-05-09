/**
 * observer: claude_code
 *
 * ~/.claude/projects/<project>/<session-id>.jsonl を読み、
 * assistant メッセージから token usage を集計する。
 *
 * v0.2: ポーリングで最新セッションファイルを再読み込み（chokidar はまだ使わない）
 * v0.3: chokidar tail で増分処理に最適化
 */

import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";

export type SessionTokenSample = {
  sessionId: string;
  ts: Date;
  /** 「コンテキスト膨張」の累積指標 = input + cache_creation + output（cache_read は除く） */
  cumulativeUncached: number;
  /** 完全な token 内訳 */
  tokens: {
    input: number;
    output: number;
    cacheCreation: number;
    cacheRead: number;
  };
  model: string;
};

export type SessionFile = {
  path: string;
  sessionId: string;
  project: string; // ディレクトリ名（cwd から導出）
  mtime: Date;
  sizeBytes: number;
};

/** assistant レコードの最低限の型（usage が無い行は無視） */
type AssistantUsage = {
  type: "assistant";
  sessionId?: string;
  timestamp?: string;
  message?: {
    model?: string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
  };
};

type AnyRecord = {
  type?: string;
  timestamp?: string;
};

/**
 * ログディレクトリ配下の全 JSONL ファイルを列挙する。
 * mtime 降順で返す。
 */
export function listSessionFiles(logDir: string): SessionFile[] {
  if (!existsSync(logDir)) return [];
  const out: SessionFile[] = [];
  for (const entry of readdirSync(logDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const project = entry.name;
    const projectDir = join(logDir, project);
    let files: string[] = [];
    try {
      files = readdirSync(projectDir);
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.endsWith(".jsonl")) continue;
      const full = join(projectDir, f);
      try {
        const st = statSync(full);
        if (!st.isFile()) continue;
        out.push({
          path: full,
          sessionId: f.replace(/\.jsonl$/, ""),
          project,
          mtime: st.mtime,
          sizeBytes: st.size,
        });
      } catch {
        // ignore
      }
    }
  }
  out.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
  return out;
}

/**
 * JSONL を読み、assistant の usage 行を SessionTokenSample[] に正規化する。
 * 累積 (cumulativeUncached) は時系列順で計算する。
 */
export function readSessionSamples(file: SessionFile): SessionTokenSample[] {
  const text = readFileSync(file.path, "utf8");
  const samples: SessionTokenSample[] = [];
  let cumulative = 0;

  for (const line of text.split("\n")) {
    if (line.length === 0) continue;
    let rec: AssistantUsage;
    try {
      rec = JSON.parse(line) as AssistantUsage;
    } catch {
      continue;
    }
    if (rec.type !== "assistant") continue;
    const usage = rec.message?.usage;
    if (!usage) continue;
    const input = usage.input_tokens ?? 0;
    const output = usage.output_tokens ?? 0;
    const cacheCreation = usage.cache_creation_input_tokens ?? 0;
    const cacheRead = usage.cache_read_input_tokens ?? 0;
    cumulative += input + output + cacheCreation;

    samples.push({
      sessionId: rec.sessionId ?? file.sessionId,
      ts: new Date(rec.timestamp ?? file.mtime.toISOString()),
      cumulativeUncached: cumulative,
      tokens: { input, output, cacheCreation, cacheRead },
      model: rec.message?.model ?? "unknown",
    });
  }

  return samples;
}

/**
 * 最新更新の N セッションを取り、各セッションの最終サンプルを返す。
 * watch ループで周期的に呼ぶ用。
 */
export function snapshotRecentSessions(
  logDir: string,
  limit = 5,
): Array<{ file: SessionFile; latest: SessionTokenSample | null }> {
  const files = listSessionFiles(logDir).slice(0, limit);
  return files.map((f) => {
    const samples = readSessionSamples(f);
    return { file: f, latest: samples.length > 0 ? samples[samples.length - 1]! : null };
  });
}

/**
 * 「アクティブな」セッションを 1 件返す。
 *
 * 単純な mtime 降順 1 位だと、過去ログのちょっとした更新（subagent や別ホスト）で
 * top が pivot し、cumulative tokens が tick ごとに乱変動する問題があった。
 * 「最新の user/assistant イベントが直近 recentMin 分以内」のフィルタで真にアクティブな
 * セッションだけを採用する。
 *
 * @param recentMin   このウィンドウ内の最新イベントを持つセッションのみ採用
 * @param candidateLimit  mtime 降順で上から確認する候補数
 */
export function findActiveSession(
  logDir: string,
  recentMin = 5,
  candidateLimit = 5,
  now: Date = new Date(),
): {
  file: SessionFile;
  lastUserAt: Date | null;
  lastAssistantAt: Date | null;
} | null {
  const cutoffMs = now.getTime() - recentMin * 60_000;
  const files = listSessionFiles(logDir).slice(0, candidateLimit);
  for (const f of files) {
    const ts = readLastEventTimestamps(f);
    const newestMs = Math.max(
      ts.lastUserAt?.getTime() ?? 0,
      ts.lastAssistantAt?.getTime() ?? 0,
    );
    if (newestMs >= cutoffMs) {
      return { file: f, lastUserAt: ts.lastUserAt, lastAssistantAt: ts.lastAssistantAt };
    }
  }
  return null;
}

/**
 * セッションファイルから最新の user / assistant タイムスタンプを取り出す。
 * AI 処理状態判定 (work_state) に使う。
 *
 * 末尾から走査して各タイプ最初の 1 件で early break。
 */
export function readLastEventTimestamps(
  file: SessionFile,
): { lastUserAt: Date | null; lastAssistantAt: Date | null } {
  const text = readFileSync(file.path, "utf8");
  const lines = text.split("\n");
  let lastUser: Date | null = null;
  let lastAssistant: Date | null = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (line.length === 0) continue;
    let rec: AnyRecord;
    try {
      rec = JSON.parse(line) as AnyRecord;
    } catch {
      continue;
    }
    if (!rec.timestamp) continue;
    if (rec.type === "user" && !lastUser) {
      lastUser = new Date(rec.timestamp);
    } else if (rec.type === "assistant" && !lastAssistant) {
      lastAssistant = new Date(rec.timestamp);
    }
    if (lastUser && lastAssistant) break;
  }
  return { lastUserAt: lastUser, lastAssistantAt: lastAssistant };
}
