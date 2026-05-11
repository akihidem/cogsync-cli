import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir, platform } from "node:os";
import { join } from "node:path";
import {
  findActiveSession,
  resolveSessionByParentPid,
  readProcessStartMs,
} from "../src/observers/claude_code.ts";

function setupLogDir(): { logDir: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "cogsync-active-"));
  const logDir = join(root, "projects");
  mkdirSync(logDir, { recursive: true });
  return { logDir, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function writeSession(
  logDir: string,
  project: string,
  sessionId: string,
  firstTs: string,
  lastTs: string,
): string {
  const projectDir = join(logDir, project);
  mkdirSync(projectDir, { recursive: true });
  const path = join(projectDir, `${sessionId}.jsonl`);
  const lines = [
    JSON.stringify({ type: "permission-mode", permissionMode: "bypassPermissions", sessionId }),
    JSON.stringify({ type: "user", sessionId, timestamp: firstTs }),
    JSON.stringify({
      type: "assistant",
      sessionId,
      timestamp: lastTs,
      message: { model: "claude-opus-4-7", usage: { input_tokens: 10, output_tokens: 20 } },
    }),
  ];
  writeFileSync(path, lines.join("\n") + "\n");
  return path;
}

test("readProcessStartMs: 非 Linux または無効 pid は null", () => {
  if (platform() === "linux") {
    assert.equal(readProcessStartMs(999_999_999), null);
  } else {
    assert.equal(readProcessStartMs(process.pid), null);
  }
});

test("readProcessStartMs: Linux で自プロセスの起動時刻が取れる", () => {
  if (platform() !== "linux") return;
  const ms = readProcessStartMs(process.pid);
  assert.notEqual(ms, null);
  assert.ok(ms! > 0);
  assert.ok(ms! <= Date.now() + 1000);
});

test("resolveSessionByParentPid: parentPid 未指定なら null", () => {
  const { logDir, cleanup } = setupLogDir();
  try {
    assert.equal(resolveSessionByParentPid(logDir, null), null);
    assert.equal(resolveSessionByParentPid(logDir, undefined), null);
    assert.equal(resolveSessionByParentPid(logDir, 0), null);
  } finally {
    cleanup();
  }
});

test("resolveSessionByParentPid: tolerance 内で最も近い first_ts のセッションを返す", () => {
  if (platform() !== "linux") return;
  const { logDir, cleanup } = setupLogDir();
  try {
    const myStartMs = readProcessStartMs(process.pid)!;
    const closeTs = new Date(myStartMs + 3_000).toISOString();
    const farTs = new Date(myStartMs - 2 * 60 * 60_000).toISOString();
    writeSession(logDir, "p1", "close-session", closeTs, closeTs);
    writeSession(logDir, "p1", "far-session", farTs, farTs);
    const got = resolveSessionByParentPid(logDir, process.pid);
    assert.notEqual(got, null);
    assert.equal(got!.sessionId, "close-session");
  } finally {
    cleanup();
  }
});

test("resolveSessionByParentPid: tolerance を超える差しか無ければ null", () => {
  if (platform() !== "linux") return;
  const { logDir, cleanup } = setupLogDir();
  try {
    const myStartMs = readProcessStartMs(process.pid)!;
    const farTs = new Date(myStartMs - 60 * 60_000).toISOString();
    writeSession(logDir, "p1", "far-session", farTs, farTs);
    assert.equal(resolveSessionByParentPid(logDir, process.pid), null);
  } finally {
    cleanup();
  }
});

test("findActiveSession: parentPid 解決成功時は resolution=parent-pid", () => {
  if (platform() !== "linux") return;
  const { logDir, cleanup } = setupLogDir();
  try {
    const myStartMs = readProcessStartMs(process.pid)!;
    const closeTs = new Date(myStartMs + 1_000).toISOString();
    const recentTs = new Date(Date.now() - 60_000).toISOString();
    writeSession(logDir, "p1", "ours", closeTs, recentTs);
    writeSession(
      logDir,
      "p1",
      "other-recent",
      new Date(myStartMs - 30 * 60_000).toISOString(),
      recentTs,
    );
    const got = findActiveSession(logDir, 5, 10, new Date(), process.pid);
    assert.notEqual(got, null);
    assert.equal(got!.resolution, "parent-pid");
    assert.equal(got!.file.sessionId, "ours");
  } finally {
    cleanup();
  }
});

test("findActiveSession: parentPid 指定なしは mtime-recent フォールバック", () => {
  const { logDir, cleanup } = setupLogDir();
  try {
    const recentTs = new Date(Date.now() - 60_000).toISOString();
    writeSession(logDir, "p1", "recent-session", recentTs, recentTs);
    const got = findActiveSession(logDir, 5, 10, new Date());
    assert.notEqual(got, null);
    assert.equal(got!.resolution, "mtime-recent");
    assert.equal(got!.file.sessionId, "recent-session");
  } finally {
    cleanup();
  }
});

test("findActiveSession: parentPid 解決失敗時は mtime-recent にフォールバック", () => {
  const { logDir, cleanup } = setupLogDir();
  try {
    const recentTs = new Date(Date.now() - 60_000).toISOString();
    writeSession(logDir, "p1", "recent-session", recentTs, recentTs);
    const got = findActiveSession(logDir, 5, 10, new Date(), 999_999_999);
    assert.notEqual(got, null);
    assert.equal(got!.resolution, "mtime-recent");
    assert.equal(got!.file.sessionId, "recent-session");
  } finally {
    cleanup();
  }
});
