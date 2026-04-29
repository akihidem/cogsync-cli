/**
 * cogsync-cli — config loader
 * 設定ファイルの場所：~/.config/cogsync/config.yaml
 * スキーマは docs/DESIGN.md §4 を参照。
 */

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

export function loadConfig(_path?: string): CogsyncConfig {
  // TODO v0.1: js-yaml で読み込み、デフォルトとマージ、env 上書き
  throw new Error("loadConfig not implemented (v0.1)");
}

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
    snowballToken: 80000,
    limitWarnMin: 15,
  },
  notify: {
    tone: "neutral",
    quietDuringAiWork: true,
  },
};
