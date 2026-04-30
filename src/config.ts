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
    limitWarnMin: number;
  };
  notify: {
    tone: "neutral" | "librarian" | "coach" | "kansai";
    quietDuringAiWork: boolean;
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
    limitWarnMin: 15,
  },
  notify: {
    tone: "neutral",
    quietDuringAiWork: true,
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
