/**
 * observer: jsonl_tail
 *
 * chokidar で ~/.claude/projects/**\/*.jsonl を監視し、
 * 各ファイルの読み済みオフセットを覚えて増分行のみパースする。
 *
 * 用途:
 * - watch ループの「セッション最新サンプル取得」を毎回フル走査せず、
 *   tail 検知 → コールバックでイベント発火に置き換える
 * - AI 処理状態（active/ai_busy/idle）の即時判定
 */

import { openSync, readSync, closeSync, statSync } from "node:fs";
import chokidar from "chokidar";
import { join } from "node:path";

export type JsonlEvent = {
  filePath: string;
  sessionId: string;
  project: string;
  /** パース成功した行 (このイベントの増分のみ) */
  records: unknown[];
  /** ファイル末尾の現サイズ (オフセット記録用) */
  newSize: number;
};

export type TailHandle = {
  stop(): Promise<void>;
};

export type StartTailOptions = {
  logDir: string;
  /** 起動時に既存ファイルの末尾までシーク（過去ログを再パースしない） */
  skipExisting?: boolean;
};

export function startJsonlTail(
  opts: StartTailOptions,
  onEvent: (e: JsonlEvent) => void,
): TailHandle {
  const offsets = new Map<string, number>();

  const watcher = chokidar.watch(join(opts.logDir, "**", "*.jsonl"), {
    ignoreInitial: false,
    persistent: true,
    awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 100 },
  });

  const handle = (path: string) => {
    try {
      const ev = readIncrement(path, offsets);
      if (ev) onEvent(ev);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[cogsync] jsonl_tail error on ${path}: ${msg}`);
    }
  };

  watcher.on("add", (path) => {
    if (opts.skipExisting) {
      try {
        offsets.set(path, statSync(path).size);
      } catch {
        offsets.set(path, 0);
      }
      return;
    }
    offsets.set(path, 0);
    handle(path);
  });

  watcher.on("change", handle);
  watcher.on("unlink", (path) => offsets.delete(path));

  return {
    async stop() {
      await watcher.close();
    },
  };
}

function readIncrement(path: string, offsets: Map<string, number>): JsonlEvent | null {
  const start = offsets.get(path) ?? 0;
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    return null;
  }
  if (size <= start) {
    offsets.set(path, size);
    return null;
  }

  const length = size - start;
  const buf = Buffer.alloc(length);
  const fd = openSync(path, "r");
  try {
    let bytesRead = 0;
    while (bytesRead < length) {
      const n = readSync(fd, buf, bytesRead, length - bytesRead, start + bytesRead);
      if (n === 0) break;
      bytesRead += n;
    }
  } finally {
    closeSync(fd);
  }

  // 末尾が改行で終わっていない場合はまだ書き込み中
  const lastNewline = buf.lastIndexOf(0x0a);
  if (lastNewline === -1) {
    return null;
  }
  const completeText = buf.slice(0, lastNewline + 1).toString("utf8");
  const endOffset = start + lastNewline + 1;
  offsets.set(path, endOffset);

  const records: unknown[] = [];
  for (const line of completeText.split("\n")) {
    if (line.length === 0) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      // skip malformed line
    }
  }
  if (records.length === 0) return null;

  // ~/.claude/projects/<project>/<sessionId>.jsonl
  const parts = path.split("/");
  const fileName = parts[parts.length - 1] ?? "";
  const project = parts[parts.length - 2] ?? "unknown";
  const sessionId = fileName.replace(/\.jsonl$/, "");

  return { filePath: path, sessionId, project, records, newSize: endOffset };
}
