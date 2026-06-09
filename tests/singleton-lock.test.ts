import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireSingleInstanceLock } from "../src/util/singleton-lock.ts";

function tmpLockPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "cogsync-lock-"));
  return join(dir, "watch.lock");
}

test("acquireSingleInstanceLock: 1本目は取得・2本目は null（稼働中の自 pid がロックを保持）", () => {
  const p = tmpLockPath();
  const a = acquireSingleInstanceLock(p);
  assert.ok(a, "1本目は取得できる");
  assert.equal(readFileSync(p, "utf8").trim(), String(process.pid), "pidfile に自 pid を書く");

  const b = acquireSingleInstanceLock(p);
  assert.equal(b, null, "生存ロックがあれば2本目は取得失敗（null）");

  a!.release();
  assert.equal(existsSync(p), false, "release でロックファイルが消える");
});

test("acquireSingleInstanceLock: stale pidfile（死亡 pid）は回収して取得できる", () => {
  const p = tmpLockPath();
  writeFileSync(p, "2147483646"); // 実在しない巨大 pid = 死亡扱い
  const a = acquireSingleInstanceLock(p);
  assert.ok(a, "stale ロックは回収して取得できる");
  assert.equal(readFileSync(p, "utf8").trim(), String(process.pid));
  a!.release();
});

test("acquireSingleInstanceLock: 壊れた pidfile も stale 扱いで回収", () => {
  const p = tmpLockPath();
  writeFileSync(p, "not-a-pid\n");
  const a = acquireSingleInstanceLock(p);
  assert.ok(a, "数値でない pidfile は stale 扱いで回収");
  a!.release();
});

test("acquireSingleInstanceLock: release は冪等（二重呼び出しで投げない）", () => {
  const p = tmpLockPath();
  const a = acquireSingleInstanceLock(p);
  assert.ok(a);
  a!.release();
  assert.doesNotThrow(() => a!.release(), "2回目の release は no-op");
});

test("acquireSingleInstanceLock: SIGINT/SIGTERM リスナーを追加しない（呼び出し側の終了保存を奪わない）", () => {
  // 回帰防止: ロックがシグナルを横取りして process.exit すると、呼び出し側(watch)の
  // 終了時 deepwork 保存が走らなくなる。ロックは exit クリーンアップのみで完結すべき。
  const p = tmpLockPath();
  const beforeInt = process.listenerCount("SIGINT");
  const beforeTerm = process.listenerCount("SIGTERM");
  const a = acquireSingleInstanceLock(p);
  assert.ok(a);
  assert.equal(process.listenerCount("SIGINT"), beforeInt, "SIGINT リスナーを足さない");
  assert.equal(process.listenerCount("SIGTERM"), beforeTerm, "SIGTERM リスナーを足さない");
  a!.release();
});
