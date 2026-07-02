/**
 * observers: statusline snapshot
 *
 * Claude Code の statusLine コマンドに stdin で渡される JSON から
 * rate_limits.five_hour / seven_day を抜き出し、cogsync の状態ディレクトリへ
 * 永続化する。ここでは生値の抽出と保存のみを行い、評価・実行系の解釈は
 * 一切しない（判定は infer/weekly.ts の役割）。
 *
 * 永続パス: ~/.local/state/cogsync/statusline.json （XDG_STATE_HOME 尊重）
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  computeWeeklyStatus,
  formatWeeklySegment,
  type RateLimitSnapshot,
  type RateLimitWindow,
  type WeeklyStatusOptions,
} from "../infer/weekly.ts";

export function defaultSnapshotPath(): string {
  const xdg = process.env["XDG_STATE_HOME"];
  const base = xdg && xdg.length > 0 ? xdg : join(homedir(), ".local", "state");
  return join(base, "cogsync", "statusline.json");
}

/**
 * 厳格 parse: five_hour / seven_day の used_percentage・resets_at が
 * 有限 number のときだけ採用する。片方欠落は許容（独立に欠落しうる、公式仕様）。
 * 両方欠落・型不正・壊れた JSON はクラッシュせず null。
 */
export function parseStatuslinePayload(jsonText: string): RateLimitSnapshot | null {
  let data: unknown;
  try {
    data = JSON.parse(jsonText);
  } catch {
    return null;
  }
  if (!isPlainObject(data)) return null;
  const rateLimits = data["rate_limits"];
  if (!isPlainObject(rateLimits)) return null;

  const fiveHour = parseWindow(rateLimits["five_hour"]);
  const sevenDay = parseWindow(rateLimits["seven_day"]);
  if (!fiveHour && !sevenDay) return null;

  const snap: RateLimitSnapshot = { capturedAtEpochMs: Date.now() };
  if (fiveHour) snap.fiveHour = fiveHour;
  if (sevenDay) snap.sevenDay = sevenDay;
  return snap;
}

function parseWindow(v: unknown): RateLimitWindow | null {
  if (!isPlainObject(v)) return null;
  const usedPct = v["used_percentage"];
  const resetsAt = v["resets_at"];
  if (typeof usedPct !== "number" || !Number.isFinite(usedPct)) return null;
  if (!isValidEpochSec(resetsAt)) return null;
  return { usedPct, resetsAtEpochSec: resetsAt };
}

/**
 * epoch 秒として Date に変換可能か。有限であっても JS Date の表現範囲
 * （±8.64e15 ms = ±100,000,000 日）を超える値（例: 1e20）は Invalid Date になり、
 * 下流の toISOString() が RangeError を投げるため、ここで弾く。
 */
function isValidEpochSec(v: unknown): v is number {
  return (
    typeof v === "number" &&
    Number.isFinite(v) &&
    Math.abs(v * 1000) <= 8.64e15
  );
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** 書き込みは temp file → rename で原子的（state/store.ts と同じ流儀） */
export function persistSnapshot(snap: RateLimitSnapshot, path: string = defaultSnapshotPath()): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(snap, null, 2));
  renameSync(tmp, path);
}

/**
 * ファイル未作成・壊れたファイルは黙って null に回復する。
 * ウィンドウ値も parse 時と同じ厳格さで再検証する（外部で書き換えられた
 * state から NaN / Invalid Date が weekly 計算や watch の dedup key に
 * 流れて RangeError になるのを防ぐ）。不正なウィンドウはそのウィンドウだけ捨てる。
 */
export function readSnapshot(path: string = defaultSnapshotPath()): RateLimitSnapshot | null {
  if (!existsSync(path)) return null;
  try {
    const data: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!isPlainObject(data)) return null;
    const capturedAtEpochMs = data["capturedAtEpochMs"];
    // 範囲チェックは resetsAt と同基準。範囲外だと new Date() が Invalid Date になり、
    // stale 判定が NaN 比較で常に false（腐った snapshot が永遠に新鮮扱い）になる。
    if (
      typeof capturedAtEpochMs !== "number" ||
      !Number.isFinite(capturedAtEpochMs) ||
      Math.abs(capturedAtEpochMs) > 8.64e15
    ) {
      return null;
    }
    const fiveHour = parsePersistedWindow(data["fiveHour"]);
    const sevenDay = parsePersistedWindow(data["sevenDay"]);
    if (!fiveHour && !sevenDay) return null;
    const snap: RateLimitSnapshot = { capturedAtEpochMs };
    if (fiveHour) snap.fiveHour = fiveHour;
    if (sevenDay) snap.sevenDay = sevenDay;
    return snap;
  } catch {
    return null;
  }
}

/** 永続形式（camelCase）のウィンドウ検証。payload 側の parseWindow と同じ厳格基準 */
function parsePersistedWindow(v: unknown): RateLimitWindow | null {
  if (!isPlainObject(v)) return null;
  const usedPct = v["usedPct"];
  const resetsAtEpochSec = v["resetsAtEpochSec"];
  if (typeof usedPct !== "number" || !Number.isFinite(usedPct)) return null;
  if (!isValidEpochSec(resetsAtEpochSec)) return null;
  return { usedPct, resetsAtEpochSec };
}

export type RunStatuslineOptions = {
  /** 判定に使う現在時刻。省略時は new Date() */
  now?: Date;
  /** snapshot 永続化パス。省略時は defaultSnapshotPath() */
  snapshotPath?: string;
  /** computeWeeklyStatus に渡す閾値。省略時は infer/weekly.ts の既定値 */
  weekly?: WeeklyStatusOptions;
};

/**
 * cogsync statusline サブコマンドの中身。stdin 全文を受け取り、
 * parse → (有効なら) persist → 1 行を返す。例外を投げない
 * （Claude Code の statusline を壊さないことが最優先。persist 失敗すら line 生成を妨げない）。
 */
export function runStatusline(
  input: string,
  opts: RunStatuslineOptions = {},
): { line: string; persisted: boolean } {
  const now = opts.now ?? new Date();
  const snap = parseStatuslinePayload(input);
  if (!snap) {
    return { line: "cogsync", persisted: false };
  }

  let persisted = true;
  try {
    persistSnapshot(snap, opts.snapshotPath);
  } catch {
    persisted = false;
  }

  // 表示行: 5h（あれば）と週次（あれば）を併記する。
  // statusline は Claude Code の行を丸ごと置き換えるため、5h 情報を落とすと
  // 素の表示より情報が減る退行になる。
  const parts: string[] = [];
  if (snap.fiveHour) {
    parts.push(`5h ${snap.fiveHour.usedPct.toFixed(0)}%`);
  }
  const ws = computeWeeklyStatus(snap, now, opts.weekly);
  if (ws) {
    parts.push(formatWeeklySegment(ws));
  }
  const line = parts.length > 0 ? `cogsync ${parts.join(" | ")}` : "cogsync";
  return { line, persisted };
}
