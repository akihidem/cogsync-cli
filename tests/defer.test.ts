import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
  DeferQueue,
  DEFERRABLE_TEMPLATES,
  DEFER_TTL_MS,
  isDeferralActive,
  buildDeliveries,
  type DeferredEntry,
} from "../src/notify/defer.ts";
import type { PhaseState } from "../src/coach/phase.ts";

const T0 = new Date("2026-05-15T10:00:00Z");

function entry(over: Partial<DeferredEntry> = {}): Omit<DeferredEntry, "queuedAt"> {
  return {
    key: over.key ?? "base:weekly_pace_exceeded",
    templateId: over.templateId ?? "weekly_pace_exceeded",
    severity: over.severity ?? "warn",
    vars: over.vars ?? { pace_delta_pt: 20 },
  };
}

// ─── isDeferralActive（L0 #2） ──────────────────────────────────────────────

test("isDeferralActive: 保護フェーズ×新鮮 → true", () => {
  const ps: PhaseState = { phase: "implement", startedAt: "2026-05-15T09:30:00Z" };
  assert.equal(isDeferralActive(ps, ["design", "implement"], 6, T0), true);
});

test("isDeferralActive: stale phase → false", () => {
  const ps: PhaseState = { phase: "implement", startedAt: "2026-05-15T02:00:00Z" }; // 8h 前
  assert.equal(isDeferralActive(ps, ["design", "implement"], 6, T0), false);
});

test("isDeferralActive: phase 未設定(null) → false", () => {
  assert.equal(isDeferralActive(null, ["design", "implement"], 6, T0), false);
});

test("isDeferralActive: 保護外フェーズ(review/break) → false", () => {
  const review: PhaseState = { phase: "review", startedAt: "2026-05-15T09:55:00Z" };
  const brk: PhaseState = { phase: "break", startedAt: "2026-05-15T09:55:00Z" };
  assert.equal(isDeferralActive(review, ["design", "implement"], 6, T0), false);
  assert.equal(isDeferralActive(brk, ["design", "implement"], 6, T0), false);
});

test("isDeferralActive: deferPhases が不正(null/object/文字列)でも落とさず false", () => {
  // config.notify.deferDuringPhases が YAML で壊れても watch を落とさない（codex 指摘）。
  const ps: PhaseState = { phase: "implement", startedAt: "2026-05-15T09:55:00Z" };
  for (const bad of [null, undefined, {}, "implement", 42]) {
    assert.doesNotThrow(() => isDeferralActive(ps, bad as never, 6, T0));
    assert.equal(isDeferralActive(ps, bad as never, 6, T0), false, String(bad));
  }
});

// ─── enqueue（L0 #3） ───────────────────────────────────────────────────────

test("enqueue: 同 key 2 回 → 1 件（後着 vars が勝つ）", () => {
  const q = new DeferQueue();
  q.enqueue(entry({ vars: { pace_delta_pt: 10 } }), T0);
  q.enqueue(entry({ vars: { pace_delta_pt: 30 } }), new Date(T0.getTime() + 60_000));
  assert.equal(q.size, 1);
  assert.equal(q.toJSON()[0]!.vars["pace_delta_pt"], 30);
});

test("enqueue: 別 key は別項目", () => {
  const q = new DeferQueue();
  q.enqueue(entry({ key: "a:weekly_pace_exceeded" }), T0);
  q.enqueue(entry({ key: "b:snowball_detected", templateId: "snowball_detected" }), T0);
  assert.equal(q.size, 2);
});

test("enqueue: 再投入で queuedAt は初回時刻を保持（vars は後着更新）", () => {
  // 毎 tick 再投入で queuedAt がリセットされると安全弁/TTL が永久に発火しない（codex 指摘）。
  const q = new DeferQueue();
  q.enqueue(entry({ vars: { pace_delta_pt: 10 } }), T0);
  const firstQueuedAt = q.toJSON()[0]!.queuedAt;
  q.enqueue(entry({ vars: { pace_delta_pt: 30 } }), new Date(T0.getTime() + 40 * 60_000));
  assert.equal(q.toJSON()[0]!.queuedAt, firstQueuedAt, "queuedAt は初回のまま");
  assert.equal(q.toJSON()[0]!.vars["pace_delta_pt"], 30, "vars は後着");
});

test("enqueue: 再投入を挟んでも初回から maxDeferMin 超過で安全弁が発火する", () => {
  const q = new DeferQueue();
  q.enqueue(entry(), T0); // 初回
  // 30 分後・50 分後に再投入（条件が出続けている想定）。queuedAt は T0 のまま。
  q.enqueue(entry(), new Date(T0.getTime() + 30 * 60_000));
  q.enqueue(entry(), new Date(T0.getTime() + 50 * 60_000));
  // 初回から 61 分後: active でも安全弁で send されるべき（queuedAt が保持されているから）
  const { send } = q.drainDue(new Date(T0.getTime() + 61 * 60_000), true, { maxDeferMin: 60 });
  assert.equal(send.length, 1);
});

// ─── drainDue（L0 #4） ──────────────────────────────────────────────────────

test("drainDue: 解除(active=false) → TTL 内の全件 send・キュー空に", () => {
  const q = new DeferQueue();
  q.enqueue(entry({ key: "a:weekly_pace_exceeded" }), T0);
  q.enqueue(entry({ key: "b:snowball_detected", templateId: "snowball_detected" }), T0);
  const { send, dropped } = q.drainDue(new Date(T0.getTime() + 5 * 60_000), false, {
    maxDeferMin: 60,
  });
  assert.equal(send.length, 2);
  assert.equal(dropped.length, 0);
  assert.equal(q.size, 0);
});

test("drainDue: active かつ age>maxDeferMin → send（安全弁）", () => {
  const q = new DeferQueue();
  q.enqueue(entry(), T0);
  const now = new Date(T0.getTime() + 61 * 60_000); // 61 分後 > 60
  const { send } = q.drainDue(now, true, { maxDeferMin: 60 });
  assert.equal(send.length, 1);
  assert.equal(q.size, 0);
});

test("drainDue: active かつ age<maxDeferMin → 保持（送らない）", () => {
  const q = new DeferQueue();
  q.enqueue(entry(), T0);
  const now = new Date(T0.getTime() + 30 * 60_000); // 30 分後 < 60
  const { send, dropped } = q.drainDue(now, true, { maxDeferMin: 60 });
  assert.equal(send.length, 0);
  assert.equal(dropped.length, 0);
  assert.equal(q.size, 1);
});

test("drainDue: age>TTL(24h) → dropped（送らない・active でも解除でも）", () => {
  for (const active of [true, false]) {
    const q = new DeferQueue();
    q.enqueue(entry(), T0);
    const now = new Date(T0.getTime() + DEFER_TTL_MS + 60_000);
    const { send, dropped } = q.drainDue(now, active, { maxDeferMin: 60 });
    assert.equal(send.length, 0, `active=${active}`);
    assert.equal(dropped.length, 1, `active=${active}`);
    assert.equal(q.size, 0);
  }
});

test("drainDue: 混在（新鮮=保持 / 古=send / TTL 超=drop）を正しく分離", () => {
  const q = new DeferQueue();
  q.enqueue(entry({ key: "fresh:weekly_pace_exceeded" }), new Date(T0.getTime() - 10 * 60_000)); // 10 分前
  q.enqueue(entry({ key: "old:snowball_detected", templateId: "snowball_detected" }), new Date(T0.getTime() - 90 * 60_000)); // 90 分前 > 60
  q.enqueue(entry({ key: "ancient:weekly_pace_exceeded" }), new Date(T0.getTime() - DEFER_TTL_MS - 60_000)); // TTL 超
  const { send, dropped } = q.drainDue(T0, true, { maxDeferMin: 60 });
  assert.deepEqual(send.map((e) => e.key), ["old:snowball_detected"]);
  assert.deepEqual(dropped.map((e) => e.key), ["ancient:weekly_pace_exceeded"]);
  assert.equal(q.size, 1); // fresh のみ残る
});

// ─── buildDeliveries / digest 分岐（L0 #5） ─────────────────────────────────

test("buildDeliveries: 0 件 → []", () => {
  assert.deepEqual(buildDeliveries([]), []);
});

test("buildDeliveries: 1 件 → 元テンプレのまま", () => {
  const e: DeferredEntry = { ...entry(), queuedAt: T0.toISOString() };
  const d = buildDeliveries([e]);
  assert.equal(d.length, 1);
  assert.equal(d[0]!.templateId, "weekly_pace_exceeded");
  assert.deepEqual(d[0]!.vars, e.vars);
});

test("buildDeliveries: 2 件以上 → deferred_digest 1 通に集約", () => {
  const a: DeferredEntry = { ...entry({ key: "a:weekly_pace_exceeded", vars: { pace_delta_pt: 20 } }), queuedAt: T0.toISOString() };
  const b: DeferredEntry = {
    ...entry({ key: "b:snowball_detected", templateId: "snowball_detected", severity: "nudge", vars: { cumulative_kt: 180 } }),
    queuedAt: T0.toISOString(),
  };
  const d = buildDeliveries([a, b]);
  assert.equal(d.length, 1);
  assert.equal(d[0]!.templateId, "deferred_digest");
  assert.equal(d[0]!.vars["count"], 2);
  assert.equal(d[0]!.severity, "warn"); // warn > nudge
  assert.ok(String(d[0]!.vars["summary"]).includes("週次"));
  assert.ok(String(d[0]!.vars["summary"]).includes("雪だるま"));
});

// ─── 永続化（L0 #6） ────────────────────────────────────────────────────────

test("toJSON/fromJSON: 往復一致", () => {
  const q = new DeferQueue();
  q.enqueue(entry({ key: "a:weekly_pace_exceeded" }), T0);
  q.enqueue(entry({ key: "b:snowball_detected", templateId: "snowball_detected" }), T0);
  const restored = DeferQueue.fromJSON(q.toJSON());
  assert.deepEqual(restored.toJSON(), q.toJSON());
});

test("fromJSON: field なし(null/undefined)や非配列 → 空キュー", () => {
  assert.equal(DeferQueue.fromJSON(null).size, 0);
  assert.equal(DeferQueue.fromJSON(undefined).size, 0);
  assert.equal(DeferQueue.fromJSON({ not: "array" }).size, 0);
  assert.equal(DeferQueue.fromJSON("garbage").size, 0);
});

test("fromJSON: 不正 entry は個別に捨て、正しい entry は残す", () => {
  const good: DeferredEntry = { ...entry(), queuedAt: T0.toISOString() };
  const restored = DeferQueue.fromJSON([
    good,
    { key: "", templateId: "x", severity: "warn", vars: {}, queuedAt: T0.toISOString() }, // 空 key
    { key: "b", templateId: "x", severity: "bogus", vars: {}, queuedAt: T0.toISOString() }, // 不正 severity
    { key: "c", templateId: "x", severity: "warn", vars: {}, queuedAt: "not-a-date" }, // 不正 queuedAt
    { key: "d", templateId: "x", severity: "warn", vars: [], queuedAt: T0.toISOString() }, // vars 配列
    null,
    "junk",
  ]);
  assert.equal(restored.size, 1);
  assert.equal(restored.toJSON()[0]!.key, good.key);
});

test("fromJSON: vars の異物(オブジェクト/配列値)は捨て、string|number のみ残す", () => {
  const restored = DeferQueue.fromJSON([
    {
      key: "a",
      templateId: "weekly_pace_exceeded",
      severity: "warn",
      vars: { pct: 78, label: "ok", nested: { x: 1 }, arr: [1] },
      queuedAt: T0.toISOString(),
    },
  ]);
  assert.deepEqual(restored.toJSON()[0]!.vars, { pct: 78, label: "ok" });
});

test("fromJSON→drainDue: 不正 queuedAt の entry は復元時点で除外されるので永久残留しない", () => {
  // queuedAt が壊れた entry を混ぜても、fromJSON が弾くので drain が NaN 年齢で詰まらない。
  const q = DeferQueue.fromJSON([
    { key: "bad", templateId: "weekly_pace_exceeded", severity: "warn", vars: {}, queuedAt: "xxx" },
    { ...entry({ key: "ok:weekly_pace_exceeded" }), queuedAt: new Date(T0.getTime() - 90 * 60_000).toISOString() },
  ]);
  assert.equal(q.size, 1);
  const { send } = q.drainDue(T0, true, { maxDeferMin: 60 });
  assert.equal(send.length, 1);
  assert.equal(send[0]!.key, "ok:weekly_pace_exceeded");
});

// ─── 集合の健全性 ───────────────────────────────────────────────────────────

test("DEFERRABLE_TEMPLATES: 戦略系のみ・時間クリティカル系は含まない", () => {
  assert.ok(DEFERRABLE_TEMPLATES.has("weekly_pace_exceeded"));
  assert.ok(DEFERRABLE_TEMPLATES.has("snowball_detected"));
  for (const t of ["limit_approaching", "burn_exhaustion", "deepwork_cap_reached", "deep_break_suggested"]) {
    assert.equal(DEFERRABLE_TEMPLATES.has(t), false, t);
  }
});
