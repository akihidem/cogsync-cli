import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseStatuslinePayload,
  persistSnapshot,
  readSnapshot,
  runStatusline,
} from "../src/observers/statusline_snapshot.ts";

// 契約 fixture: cogsync repo data/statusline-rate-limits-sample.json と同一形状
// （rate_limits.five_hour / seven_day、used_percentage 0-100、resets_at は Unix epoch 秒）。
const VALID_FIXTURE = JSON.stringify({
  rate_limits: {
    five_hour: { used_percentage: 62, resets_at: 1782033600 },
    seven_day: { used_percentage: 78, resets_at: 1782270000 },
  },
});

function tmpSnapshotPath(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "cogsync-statusline-"));
  return {
    path: join(dir, "statusline.json"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

// ─── parseStatuslinePayload ─────────────────────────────────────────────────

test("parseStatuslinePayload: 正常 fixture は five_hour / seven_day 両方を採用", () => {
  const snap = parseStatuslinePayload(VALID_FIXTURE);
  assert.notEqual(snap, null);
  assert.deepEqual(snap!.fiveHour, { usedPct: 62, resetsAtEpochSec: 1782033600 });
  assert.deepEqual(snap!.sevenDay, { usedPct: 78, resetsAtEpochSec: 1782270000 });
  assert.equal(typeof snap!.capturedAtEpochMs, "number");
  assert.ok(Number.isFinite(snap!.capturedAtEpochMs));
});

test("parseStatuslinePayload: five_hour のみでも部分採用", () => {
  const text = JSON.stringify({ rate_limits: { five_hour: { used_percentage: 10, resets_at: 111 } } });
  const snap = parseStatuslinePayload(text);
  assert.notEqual(snap, null);
  assert.deepEqual(snap!.fiveHour, { usedPct: 10, resetsAtEpochSec: 111 });
  assert.equal(snap!.sevenDay, undefined);
});

test("parseStatuslinePayload: seven_day のみでも部分採用", () => {
  const text = JSON.stringify({ rate_limits: { seven_day: { used_percentage: 20, resets_at: 222 } } });
  const snap = parseStatuslinePayload(text);
  assert.notEqual(snap, null);
  assert.equal(snap!.fiveHour, undefined);
  assert.deepEqual(snap!.sevenDay, { usedPct: 20, resetsAtEpochSec: 222 });
});

test("parseStatuslinePayload: 両方欠落は null", () => {
  assert.equal(parseStatuslinePayload(JSON.stringify({ rate_limits: {} })), null);
});

test("parseStatuslinePayload: rate_limits 自体が無ければ null", () => {
  assert.equal(parseStatuslinePayload(JSON.stringify({})), null);
});

test("parseStatuslinePayload: 型不正（文字列）フィールドはそのフィールドだけ捨てる", () => {
  const text = JSON.stringify({
    rate_limits: {
      five_hour: { used_percentage: "62", resets_at: 1782033600 },
      seven_day: { used_percentage: 78, resets_at: 1782270000 },
    },
  });
  const snap = parseStatuslinePayload(text);
  assert.notEqual(snap, null);
  assert.equal(snap!.fiveHour, undefined, "文字列の used_percentage は無効");
  assert.deepEqual(snap!.sevenDay, { usedPct: 78, resetsAtEpochSec: 1782270000 });
});

test("parseStatuslinePayload: 型不正（NaN トークン含む）は JSON.parse 自体が失敗し null", () => {
  // JSON 仕様は裸の NaN を許容しないため、この時点で構文エラーになる。
  const text = '{"rate_limits":{"seven_day":{"used_percentage":NaN,"resets_at":1}}}';
  assert.doesNotThrow(() => parseStatuslinePayload(text));
  assert.equal(parseStatuslinePayload(text), null);
});

test("parseStatuslinePayload: 壊れた JSON はクラッシュせず null", () => {
  assert.doesNotThrow(() => parseStatuslinePayload("{not json"));
  assert.equal(parseStatuslinePayload("{not json"), null);
});

test("parseStatuslinePayload: 空 stdin はクラッシュせず null", () => {
  assert.doesNotThrow(() => parseStatuslinePayload(""));
  assert.equal(parseStatuslinePayload(""), null);
});

// ─── persistSnapshot / readSnapshot ─────────────────────────────────────────

test("persistSnapshot → readSnapshot: 往復で値が一致", () => {
  const { path, cleanup } = tmpSnapshotPath();
  try {
    const snap = parseStatuslinePayload(VALID_FIXTURE)!;
    persistSnapshot(snap, path);
    assert.deepEqual(readSnapshot(path), snap);
  } finally {
    cleanup();
  }
});

test("readSnapshot: ファイル未作成は null", () => {
  const { path, cleanup } = tmpSnapshotPath();
  try {
    assert.equal(readSnapshot(path), null);
  } finally {
    cleanup();
  }
});

test("readSnapshot: 壊れたファイルは黙って null に回復する", () => {
  const { path, cleanup } = tmpSnapshotPath();
  try {
    writeFileSync(path, "{not valid json");
    assert.doesNotThrow(() => readSnapshot(path));
    assert.equal(readSnapshot(path), null);
  } finally {
    cleanup();
  }
});

test("readSnapshot: 想定外の形（capturedAtEpochMs 欠落）は null", () => {
  const { path, cleanup } = tmpSnapshotPath();
  try {
    writeFileSync(path, JSON.stringify({ sevenDay: { usedPct: 1, resetsAtEpochSec: 1 } }));
    assert.equal(readSnapshot(path), null);
  } finally {
    cleanup();
  }
});

// ─── runStatusline（L0 #5） ──────────────────────────────────────────────────

test("runStatusline: 正常入力は 1 行返し persisted=true", () => {
  const { path, cleanup } = tmpSnapshotPath();
  try {
    const result = runStatusline(VALID_FIXTURE, { snapshotPath: path });
    assert.equal(typeof result.line, "string");
    assert.ok(result.line.length > 0);
    assert.ok(!result.line.includes("\n"), "statusline は 1 行のみ");
    assert.equal(result.persisted, true);
    assert.notEqual(readSnapshot(path), null);
  } finally {
    cleanup();
  }
});

test("runStatusline: 壊れ入力は例外を投げずフォールバック行 'cogsync' を返す（exit 0 相当）", () => {
  const { path, cleanup } = tmpSnapshotPath();
  try {
    let result: { line: string; persisted: boolean } | undefined;
    assert.doesNotThrow(() => {
      result = runStatusline("{not json", { snapshotPath: path });
    });
    assert.equal(result!.line, "cogsync");
    assert.equal(result!.persisted, false);
    assert.equal(readSnapshot(path), null, "parse 失敗時は persist しない");
  } finally {
    cleanup();
  }
});

test("runStatusline: 空 stdin もフォールバック行で例外なし", () => {
  const { path, cleanup } = tmpSnapshotPath();
  try {
    const result = runStatusline("", { snapshotPath: path });
    assert.equal(result.line, "cogsync");
    assert.equal(result.persisted, false);
  } finally {
    cleanup();
  }
});

test("runStatusline: five_hour のみ（sevenDay 欠落）でも persist され 5h 断片を表示する", () => {
  const { path, cleanup } = tmpSnapshotPath();
  try {
    const text = JSON.stringify({ rate_limits: { five_hour: { used_percentage: 10, resets_at: 111 } } });
    const result = runStatusline(text, { snapshotPath: path });
    assert.equal(result.persisted, true, "有効な parse なので persist する");
    assert.equal(result.line, "cogsync 5h 10%", "週次は無くても 5h 情報は落とさない");
  } finally {
    cleanup();
  }
});

test("runStatusline: 両ウィンドウありの行は 5h と週次を併記する", () => {
  const { path, cleanup } = tmpSnapshotPath();
  try {
    const result = runStatusline(VALID_FIXTURE, { snapshotPath: path });
    assert.ok(result.line.startsWith("cogsync 5h "), `5h 断片が先頭に来る: ${result.line}`);
    assert.ok(result.line.includes("週次"), `週次断片を含む: ${result.line}`);
    assert.ok(!result.line.includes("\n"));
  } finally {
    cleanup();
  }
});

test("readSnapshot: ウィンドウ値が型不正な永続ファイルはそのウィンドウだけ捨てる", () => {
  const { path, cleanup } = tmpSnapshotPath();
  try {
    writeFileSync(
      path,
      JSON.stringify({
        capturedAtEpochMs: Date.now(),
        fiveHour: { usedPct: 42, resetsAtEpochSec: 1782033600 },
        sevenDay: { usedPct: "abc", resetsAtEpochSec: null }, // 外部で壊された想定
      }),
    );
    const snap = readSnapshot(path);
    assert.notEqual(snap, null, "有効な fiveHour が残るので null ではない");
    assert.ok(snap!.fiveHour, "有効ウィンドウは保持");
    assert.equal(snap!.sevenDay, undefined, "不正ウィンドウは捨てる（NaN を下流に流さない）");
  } finally {
    cleanup();
  }
});

test("readSnapshot: 全ウィンドウ不正なら null（watch の dedup key で RangeError にしない）", () => {
  const { path, cleanup } = tmpSnapshotPath();
  try {
    writeFileSync(
      path,
      JSON.stringify({
        capturedAtEpochMs: Date.now(),
        sevenDay: { usedPct: Infinity, resetsAtEpochSec: "later" },
      }),
    );
    assert.equal(readSnapshot(path), null);
  } finally {
    cleanup();
  }
});

test("parseStatuslinePayload / readSnapshot: 有限だが Date 範囲外の epoch 秒（1e20）は捨てる", () => {
  // Number.isFinite(1e20) は true だが new Date(1e20*1000) は Invalid Date。
  // watch の dedup key (resetsAt.toISOString()) の RangeError 経路（codex round2 指摘）。
  const payload = JSON.stringify({
    rate_limits: { seven_day: { used_percentage: 100, resets_at: 1e20 } },
  });
  assert.equal(parseStatuslinePayload(payload), null, "payload 入口で弾く");

  const { path, cleanup } = tmpSnapshotPath();
  try {
    writeFileSync(
      path,
      JSON.stringify({
        capturedAtEpochMs: Date.now(),
        sevenDay: { usedPct: 100, resetsAtEpochSec: 1e20 },
      }),
    );
    assert.equal(readSnapshot(path), null, "永続ファイル入口でも弾く");
  } finally {
    cleanup();
  }
});

test("readSnapshot: capturedAtEpochMs が Date 範囲外（1e20 ms）なら null（stale 判定の NaN 化防止）", () => {
  const { path, cleanup } = tmpSnapshotPath();
  try {
    writeFileSync(
      path,
      JSON.stringify({
        capturedAtEpochMs: 1e20,
        sevenDay: { usedPct: 100, resetsAtEpochSec: Math.floor(Date.now() / 1000) },
      }),
    );
    assert.equal(readSnapshot(path), null);
  } finally {
    cleanup();
  }
});
