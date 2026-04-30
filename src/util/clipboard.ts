/**
 * util: clipboard
 *
 * クロスプラットフォームのクリップボード書き込み。
 * 試行順: clip.exe (WSL/Windows) → wl-copy (Wayland) → xclip (X11) → pbcopy (macOS)
 *
 * いずれも失敗したら IsCopiedFalse を返す（呼び出し側でフォールバック）。
 */

import { spawn } from "node:child_process";

const CANDIDATES: Array<{ cmd: string; args: string[] }> = [
  { cmd: "clip.exe", args: [] },
  { cmd: "wl-copy", args: [] },
  { cmd: "xclip", args: ["-selection", "clipboard"] },
  { cmd: "pbcopy", args: [] },
];

export type CopyResult =
  | { ok: true; via: string }
  | { ok: false; tried: string[]; lastError?: string };

export async function copyToClipboard(text: string): Promise<CopyResult> {
  const tried: string[] = [];
  let lastError: string | undefined;

  for (const c of CANDIDATES) {
    tried.push(c.cmd);
    try {
      await runWithStdin(c.cmd, c.args, text);
      return { ok: true, via: c.cmd };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      // 次の候補を試す
    }
  }

  return { ok: false, tried, lastError };
}

function runWithStdin(cmd: string, args: string[], stdin: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(cmd, args, { stdio: ["pipe", "ignore", "pipe"] });
    } catch (err) {
      reject(err);
      return;
    }
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => reject(err));
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} exited ${code}: ${stderr.trim()}`));
    });
    child.stdin?.write(stdin);
    child.stdin?.end();
  });
}
