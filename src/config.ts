/**
 * cogsync-cli — config loader
 *
 * 解決順序（後勝ち）:
 *   1. DEFAULT_CONFIG
 *   2. ~/.config/cogsync/config.yaml （存在すれば）
 *   3. --config <path> で指定したファイル
 *   4. 環境変数 COGSYNC_CONFIG が指すファイル
 *
 * 設定スキーマは docs/DESIGN.md §4 を参照。
 */

import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import yaml from "js-yaml";
import type { Phase } from "./coach/phase.ts";

export type CogsyncConfig = {
  profile: {
    parallelCapacity: number;
    dailyDeepWorkCapMin: number;
    hourlyRateYen: number;
  };
  observers: {
    ccusage: { enabled: boolean; pollingSec: number };
    claudeCode: { enabled: boolean; logDir: string };
  };
  thresholds: {
    snowballToken: number;
    /** snowball 発火に必要な最小ターン数（heavy-context 起動時の誤発火抑制） */
    snowballMinTurns: number;
    limitWarnMin: number;
    aiWaitBreakMin: number;
    /** アクティブ判定: 最新の user/assistant が直近 N 分以内ならアクティブ（top session 揺らぎ抑制） */
    activeSessionWindowMin: number;
    /** 通知のグローバル cooldown: 同 templateId は N 分以内に再通知しない（spam 抑制） */
    notifyCooldownMin: number;
    /** phase 自動失効: phase set から N 時間経過したら未設定扱い（古い phase を引きずらない） */
    phaseStaleHours: number;
    /**
     * 週次 red 判定のマージン（pt）。paceDeltaPct（消費% − 予算線%）がこれを超えたら red。
     * 根拠: cogsync repo §9 E1（週次が binding。「木曜飢饉」は 5h 表示では防げない）。
     */
    weeklyRedMarginPct: number;
    /**
     * statusline snapshot の鮮度しきい値（分）。capturedAt から N 分超で stale とみなし、
     * 週次 red の通知を抑止する。根拠: cogsync repo §9 E1。
     */
    weeklySnapshotStaleMin: number;
    /**
     * リザーブ率 φ（0-1）。自律バッチ（cron/banto）の 5h 窓リザーブ。5h 残量がこれを
     * 割るとバッチを止める（can_i_run_batch）。根拠: cogsync repo §9 E3（φ=0.3 で在席飢餓減）。
     */
    reservePhi: number;
    /** 5h 残量が観測できない（statusLine 未設定/stale）とき、リザーブゲートを通すか止めるか。 */
    reserveGateOnUnknown: "allow" | "deny";
  };
  notify: {
    tone: "neutral" | "librarian" | "coach" | "kansai";
    quietDuringAiWork: boolean;
    /**
     * 繰延を効かせる保護フェーズ。この phase 中は戦略系通知（週次ペース・雪だるま）を
     * フェーズ境界まで保留する。根拠: cogsync repo §9 E5（deep 中の割り込みを 0 化）。
     */
    deferDuringPhases: Phase[];
    /** 繰延の安全弁（分）。保護フェーズが続いてもこの分を超えた項目は流す（黙って飲み込まない）。 */
    maxDeferMin: number;
  };
};

export const DEFAULT_CONFIG: CogsyncConfig = {
  profile: {
    parallelCapacity: 3,
    dailyDeepWorkCapMin: 240,
    hourlyRateYen: 5000,
  },
  observers: {
    ccusage: { enabled: true, pollingSec: 30 },
    claudeCode: { enabled: true, logDir: "~/.claude/projects" },
  },
  thresholds: {
    // バックテスト (scripts/backtest-snowball.ts) で 373 セッションの分布を確認:
    //   p50=7k / p75=28k / p90=131k / p95=533k / p99=7M
    // 80k だと 20% のセッションが triggered で多すぎる。
    // 150k (≈ p90 強) で 約 12% に絞り、本当に Lost-in-the-middle 圏のものを通知。
    snowballToken: 150_000,
    // SessionStart フックや MEMORY.md 注入で初手から 150k を超える環境が
    // あるため、最低 3 ターン進むまで snowball を抑止する。
    snowballMinTurns: 3,
    limitWarnMin: 15,
    /** ai_busy がこの分以上続いたらブレイク提案（CO-5） */
    aiWaitBreakMin: 5,
    activeSessionWindowMin: 5,
    notifyCooldownMin: 15,
    phaseStaleHours: 6,
    weeklyRedMarginPct: 14.3,
    weeklySnapshotStaleMin: 60,
    reservePhi: 0.3,
    reserveGateOnUnknown: "allow",
  },
  notify: {
    tone: "neutral",
    quietDuringAiWork: true,
    deferDuringPhases: ["design", "implement"],
    maxDeferMin: 60,
  },
};

export const DEFAULT_CONFIG_PATH = join(homedir(), ".config", "cogsync", "config.yaml");

export type ConfigSource = {
  /** どこから読んだか（ログ表示用） */
  loadedFrom: string[];
  config: CogsyncConfig;
};

export function loadConfig(opts: { override?: string } = {}): ConfigSource {
  const sources: string[] = ["defaults"];
  let merged: CogsyncConfig = structuredClone(DEFAULT_CONFIG);

  // 2. ~/.config/cogsync/config.yaml
  if (existsSync(DEFAULT_CONFIG_PATH)) {
    merged = mergeDeep(merged, readYaml(DEFAULT_CONFIG_PATH)) as CogsyncConfig;
    sources.push(DEFAULT_CONFIG_PATH);
  }

  // 3. --config <path>
  if (opts.override) {
    if (!existsSync(opts.override)) {
      throw new Error(`config file not found: ${opts.override}`);
    }
    merged = mergeDeep(merged, readYaml(opts.override)) as CogsyncConfig;
    sources.push(opts.override);
  }

  // 4. 環境変数
  const envPath = process.env["COGSYNC_CONFIG"];
  if (envPath) {
    if (!existsSync(envPath)) {
      throw new Error(`config file not found (COGSYNC_CONFIG): ${envPath}`);
    }
    merged = mergeDeep(merged, readYaml(envPath)) as CogsyncConfig;
    sources.push(envPath);
  }

  // ~ 展開
  merged.observers.claudeCode.logDir = expandHome(merged.observers.claudeCode.logDir);

  return { loadedFrom: sources, config: merged };
}

function readYaml(path: string): unknown {
  const text = readFileSync(path, "utf8");
  const data = yaml.load(text);
  if (data === null || typeof data !== "object") {
    throw new Error(`invalid YAML in ${path}: expected an object`);
  }
  return data;
}

function expandHome(p: string): string {
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  if (p === "~") return homedir();
  return p;
}

type DeepObject = { [k: string]: unknown };

function isPlainObject(v: unknown): v is DeepObject {
  if (v === null || typeof v !== "object") return false;
  const proto = Object.getPrototypeOf(v) as object | null;
  return proto === Object.prototype || proto === null;
}

/** 深いマージ。配列は上書き、オブジェクトのみ再帰マージ */
function mergeDeep(base: unknown, overlay: unknown): unknown {
  if (!isPlainObject(base) || !isPlainObject(overlay)) return overlay;
  const out: DeepObject = { ...base };
  for (const [k, v] of Object.entries(overlay)) {
    out[k] = k in base ? mergeDeep(base[k], v) : v;
  }
  return out;
}
