/**
 * infer: 週次 pacing（7日ローリングウィンドウ）
 *
 * 5h ウィンドウ表示だけでは「木曜飢饉」（週の後半でリミットが尽きる）を防げない
 * （cogsync 本体 §9 E1）。statusline JSON の rate_limits.seven_day を観測し、
 * 「1 週間を均等に消費した場合の理論値（予算線）」に対して実消費がどれだけ
 * 先行しているかを判定する。
 *
 * 時計は必ず引数 now で注入する（テスト決定性のため Date.now() を内部で呼ばない）。
 */

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** 既定の red マージン（pt）。100/7 ≈ 14.2857 は「1 週間を均等消費した場合の 1 日分」に相当。 */
export const DEFAULT_RED_MARGIN_PCT = 100 / 7;
/** 既定の stale しきい値（分） */
export const DEFAULT_STALE_AFTER_MIN = 60;

export type RateLimitWindow = {
  usedPct: number;
  resetsAtEpochSec: number;
};

/** statusline payload から抜いた生値をそのまま保持する。評価・実行系の解釈はしない。 */
export type RateLimitSnapshot = {
  fiveHour?: RateLimitWindow;
  sevenDay?: RateLimitWindow;
  capturedAtEpochMs: number;
};

export type WeeklyLevel = "green" | "yellow" | "red";

export type WeeklyStatus = {
  level: WeeklyLevel;
  /** rate_limits.seven_day.used_percentage をそのまま */
  usedPct: number;
  /** 1 週間を均等消費した場合の理論値 (%) */
  budgetLinePct: number;
  /** usedPct - budgetLinePct。正なら予算線より消費が先行している */
  paceDeltaPct: number;
  /** 週次ウィンドウの開始時刻 (resetsAt - 7d) */
  windowStart: Date;
  /** 週次ウィンドウの終了（リセット）時刻 */
  resetsAt: Date;
  /** windowStart から now までの経過割合 (0-1 にクランプ) */
  elapsedFraction: number;
  /** 現ペースのまま推移した場合に 100% へ到達する時刻。リセット以降になる場合は null */
  projectedExhaustionAt: Date | null;
  /** snapshot の鮮度。capturedAt から now までが staleAfterMin を超えたら true */
  stale: boolean;
  /** snapshot が観測された時刻 */
  capturedAt: Date;
};

export type WeeklyStatusOptions = {
  /** red 判定のマージン (pt)。既定 DEFAULT_RED_MARGIN_PCT */
  redMarginPct?: number;
  /** stale 判定のしきい値 (分)。既定 DEFAULT_STALE_AFTER_MIN */
  staleAfterMin?: number;
};

/**
 * 週次 pacing を計算する。sevenDay が無い snapshot は判定材料が無いので null。
 * 0 除算は起こさない（elapsedFraction=0 や usedPct=0 は projectedExhaustionAt が null になるだけ）。
 */
export function computeWeeklyStatus(
  snap: RateLimitSnapshot,
  now: Date,
  opts: WeeklyStatusOptions = {},
): WeeklyStatus | null {
  const sevenDay = snap.sevenDay;
  if (!sevenDay) return null;

  const redMarginPct = opts.redMarginPct ?? DEFAULT_RED_MARGIN_PCT;
  const staleAfterMin = opts.staleAfterMin ?? DEFAULT_STALE_AFTER_MIN;

  const resetsAt = new Date(sevenDay.resetsAtEpochSec * 1000);
  // 出口側の防衛: Invalid Date の WeeklyStatus を絶対に返さない
  // （resetsAt.toISOString() を dedup key に使う watch を RangeError から守る）。
  // 入口（statusline_snapshot の isValidEpochSec）と二重にしてある。
  if (!Number.isFinite(resetsAt.getTime())) return null;
  const windowStart = new Date(resetsAt.getTime() - WEEK_MS);
  const elapsedFraction = clamp01((now.getTime() - windowStart.getTime()) / WEEK_MS);
  const usedPct = sevenDay.usedPct;
  const budgetLinePct = 100 * elapsedFraction;
  const paceDeltaPct = usedPct - budgetLinePct;

  let level: WeeklyLevel;
  if (paceDeltaPct > redMarginPct || usedPct >= 100) {
    level = "red";
  } else if (paceDeltaPct > 0) {
    level = "yellow";
  } else {
    level = "green";
  }

  // 線形予測: rate = usedPct / elapsedFraction (elapsedFraction を「週」単位とした % レート)。
  // elapsedFraction=0 または usedPct=0 は 0 除算・無限大になるため計算しない。
  let projectedExhaustionAt: Date | null = null;
  if (elapsedFraction > 0 && usedPct > 0) {
    const rate = usedPct / elapsedFraction;
    const fractionAt100 = 100 / rate;
    // リセットより手前に来るときだけ非 null（fractionAt100 === 1 は resetsAt そのものなので除外）
    if (fractionAt100 < 1) {
      projectedExhaustionAt = new Date(windowStart.getTime() + fractionAt100 * WEEK_MS);
    }
  }

  const capturedAt = new Date(snap.capturedAtEpochMs);
  const stale = now.getTime() - capturedAt.getTime() > staleAfterMin * 60_000;

  return {
    level,
    usedPct,
    budgetLinePct,
    paceDeltaPct,
    windowStart,
    resetsAt,
    elapsedFraction,
    projectedExhaustionAt,
    stale,
    capturedAt,
  };
}

/** `cogsync status` 用の 1 行。stale なら末尾に "(stale)" を付ける。 */
export function formatWeeklyLine(ws: WeeklyStatus): string {
  const parts: string[] = [];
  parts.push(`週次ペース ${ws.level}`);
  parts.push(`消費 ${fmtPct(ws.usedPct)}`);
  parts.push(`予算線 ${fmtPct(ws.budgetLinePct)} (${fmtSignedPct(ws.paceDeltaPct)})`);
  if (ws.projectedExhaustionAt) {
    parts.push(`枯渇予測 ${formatWeekdayHHMM(ws.projectedExhaustionAt)}`);
  }
  let line = parts.join(" | ");
  if (ws.stale) line += " (stale)";
  return line;
}

/** Claude Code の statusLine コマンド出力用の短い断片。1 行厳守。
 * ブランド接頭辞は付けない（行の組み立ては runStatusline 側の責務）。 */
export function formatWeeklySegment(ws: WeeklyStatus): string {
  const staleTag = ws.stale ? "?" : "";
  // 100% 到達の red は「+0.0pt」より「100%」の方が正確（advise.ts の cap 経路と同じ理由）
  if (ws.usedPct >= 100) {
    return `週次${ws.level}${staleTag} ${fmtPct(ws.usedPct)}`;
  }
  return `週次${ws.level}${staleTag} ${fmtSignedPct(ws.paceDeltaPct)}`;
}

/** 「曜日 HH:MM」形式（ローカル時刻）。coach/advise.ts の rationale でも共用する。 */
export function formatWeekdayHHMM(d: Date): string {
  const wd = WEEKDAY_JA[d.getDay()]!;
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${wd} ${hh}:${mm}`;
}

const WEEKDAY_JA = ["日", "月", "火", "水", "木", "金", "土"];

function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
}

function fmtPct(n: number): string {
  return `${n.toFixed(1)}%`;
}

function fmtSignedPct(n: number): string {
  const sign = n >= 0 ? "+" : "";
  return `${sign}${n.toFixed(1)}pt`;
}
