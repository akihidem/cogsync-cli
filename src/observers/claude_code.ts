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
import { platform } from "node:os";

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
  permissionMode?: string;
};

/** Claude Code が JSONL に書く permissionMode を 3 バケットへ正規化する。 */
export type PermissionMode = "manual" | "auto" | "bypass";
export function normalizePermissionMode(raw: string | undefined | null): PermissionMode {
  if (raw === "bypassPermissions") return "bypass";
  if (raw === "auto" || raw === "acceptEdits" || raw === "plan") return "auto";
  return "manual";
}

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
 * Linux 専用: 指定 pid のプロセス起動時刻 (epoch ms) を返す。
 * /proc/<pid>/stat (field 22) と /proc/stat (btime) と CLK_TCK から算出。
 * 解決できなければ null。
 *
 * MCP server は Claude Code から stdio で spawn されるので、process.ppid が
 * Claude Code のプロセス ID になる。その起動時刻を session JSONL の first_ts と
 * 突き合わせれば「呼び出し元 Claude Code がどのセッションファイルを書いているか」
 * を高精度に同定できる。
 */
export function readProcessStartMs(pid: number): number | null {
  if (platform() !== "linux") return null;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const rparen = stat.lastIndexOf(")");
    if (rparen < 0) return null;
    const fields = stat.slice(rparen + 2).split(" ");
    const startJiffies = Number(fields[19]);
    if (!Number.isFinite(startJiffies)) return null;
    const stat2 = readFileSync("/proc/stat", "utf8");
    const btimeLine = stat2.split("\n").find((l) => l.startsWith("btime "));
    if (!btimeLine) return null;
    const btime = Number(btimeLine.split(" ")[1]);
    if (!Number.isFinite(btime)) return null;
    const clkTck = 100;
    return Math.round((btime + startJiffies / clkTck) * 1000);
  } catch {
    return null;
  }
}

function readFirstTimestamp(path: string): Date | null {
  try {
    const text = readFileSync(path, "utf8");
    for (const line of text.split("\n")) {
      if (line.length === 0) continue;
      try {
        const rec = JSON.parse(line) as { timestamp?: string };
        if (rec.timestamp) return new Date(rec.timestamp);
      } catch {
        continue;
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * 呼び出し元 Claude Code (parent pid) の起動時刻と各 session JSONL の first_ts を
 * 突き合わせ、最も近いものを返す。tolerance を超える差しか無ければ null。
 *
 * これにより、複数 Claude Code ウィンドウ並行起動時や、過去セッションが
 * subagent 等で touch されている場合でも、呼び出し元自身のセッションを特定できる。
 *
 * @param toleranceMs  parent_start と first_ts のずれの許容範囲（既定 120 秒）
 */
export function resolveSessionByParentPid(
  logDir: string,
  parentPid: number | null | undefined,
  toleranceMs = 120_000,
  candidateLimit = 20,
): SessionFile | null {
  if (!parentPid) return null;
  const parentStartMs = readProcessStartMs(parentPid);
  if (parentStartMs === null) return null;
  const files = listSessionFiles(logDir).slice(0, candidateLimit);
  let best: { file: SessionFile; delta: number } | null = null;
  for (const f of files) {
    const firstTs = readFirstTimestamp(f.path);
    if (!firstTs) continue;
    const delta = Math.abs(firstTs.getTime() - parentStartMs);
    if (delta > toleranceMs) continue;
    if (best === null || delta < best.delta) best = { file: f, delta };
  }
  return best?.file ?? null;
}

/**
 * 「アクティブな」セッションを 1 件返す。
 *
 * 解決順序:
 * 1. parentPid 指定時: 親プロセス（Claude Code）の起動時刻と各 session JSONL の
 *    first_ts を突き合わせて確実に同定する（multi-window 対応）。
 * 2. フォールバック: 「最新の user/assistant イベントが直近 recentMin 分以内」の
 *    最 mtime セッション。standalone daemon (cogsync watch) のように parent が
 *    Claude Code ではない呼び出し元向け。
 *
 * 単純な mtime 降順 1 位だと、過去ログのちょっとした更新（subagent や別ホスト）で
 * top が pivot し、cumulative tokens が tick ごとに乱変動する問題があったため、
 * MCP server からの呼び出しでは parentPid 経由の同定を優先する。
 *
 * @param parentPid   呼び出し元プロセス ID（MCP server 内では process.ppid）
 * @param recentMin   フォールバック時の最新イベント許容ウィンドウ
 * @param candidateLimit  mtime 降順で上から確認する候補数
 */
export function findActiveSession(
  logDir: string,
  recentMin = 5,
  candidateLimit = 5,
  now: Date = new Date(),
  parentPid: number | null = null,
): {
  file: SessionFile;
  lastUserAt: Date | null;
  lastAssistantAt: Date | null;
  currentPermissionMode: PermissionMode;
  resolution: "parent-pid" | "mtime-recent";
} | null {
  const byParent = resolveSessionByParentPid(logDir, parentPid);
  if (byParent) {
    const ts = readLastEventTimestamps(byParent);
    return {
      file: byParent,
      lastUserAt: ts.lastUserAt,
      lastAssistantAt: ts.lastAssistantAt,
      currentPermissionMode: ts.currentPermissionMode,
      resolution: "parent-pid",
    };
  }
  const cutoffMs = now.getTime() - recentMin * 60_000;
  const files = listSessionFiles(logDir).slice(0, candidateLimit);
  for (const f of files) {
    const ts = readLastEventTimestamps(f);
    const newestMs = Math.max(
      ts.lastUserAt?.getTime() ?? 0,
      ts.lastAssistantAt?.getTime() ?? 0,
    );
    if (newestMs >= cutoffMs) {
      return {
        file: f,
        lastUserAt: ts.lastUserAt,
        lastAssistantAt: ts.lastAssistantAt,
        currentPermissionMode: ts.currentPermissionMode,
        resolution: "mtime-recent",
      };
    }
  }
  return null;
}

/**
 * セッションファイルから最新の user / assistant タイムスタンプを取り出す。
 * AI 処理状態判定 (work_state) に使う。
 *
 * 末尾から走査して各タイプ最初の 1 件で early break。
 * 併せて、末尾走査中に最初に観測した permissionMode を「現行モード」として返す
 * （permission-mode タイプの transition record、または user/assistant record の
 *  permissionMode フィールドのどちらでも採用）。観測できなければ "manual"（default）。
 */
export function readLastEventTimestamps(
  file: SessionFile,
): { lastUserAt: Date | null; lastAssistantAt: Date | null; currentPermissionMode: PermissionMode } {
  const text = readFileSync(file.path, "utf8");
  const lines = text.split("\n");
  let lastUser: Date | null = null;
  let lastAssistant: Date | null = null;
  let mode: PermissionMode | null = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (line.length === 0) continue;
    let rec: AnyRecord;
    try {
      rec = JSON.parse(line) as AnyRecord;
    } catch {
      continue;
    }
    if (mode === null && rec.permissionMode) {
      mode = normalizePermissionMode(rec.permissionMode);
    }
    if (!rec.timestamp) continue;
    if (rec.type === "user" && !lastUser) {
      lastUser = new Date(rec.timestamp);
    } else if (rec.type === "assistant" && !lastAssistant) {
      lastAssistant = new Date(rec.timestamp);
    }
    if (lastUser && lastAssistant && mode !== null) break;
  }
  return {
    lastUserAt: lastUser,
    lastAssistantAt: lastAssistant,
    currentPermissionMode: mode ?? "manual",
  };
}
