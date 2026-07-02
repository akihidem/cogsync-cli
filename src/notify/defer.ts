/**
 * notify: 繰延キュー（v-next #2）
 *
 * deep（保護フェーズ）中の非緊急・戦略系通知をフェーズ境界まで保留し、境界で
 * まとめて届ける。根拠: cogsync 本体 §9 E5（繰延で deep 割り込み 3.8→0 回/週、
 * handback 遅延は平均 16 分）・Iqbal & Bailey 2008 / Kuo et al. IUI 2026。
 *
 * 純関数＋データ構造のみ。時計は必ず引数 now 注入（Date.now() を内部で呼ばない）。
 * 送信・cooldown 登録は watch.ts 側の責務（本モジュールは判定と保持だけ）。
 */

import type { Phase, PhaseState } from "../coach/phase.ts";
import { isPhaseStale } from "../coach/phase.ts";
import type { NotifySeverity } from "./desktop.ts";

/** 繰延 TTL（定数・24h）。これを超えた項目は送らず破棄する（昨日の警告を今日届けない）。 */
export const DEFER_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * 繰延対象テンプレ（戦略系のみ）。
 * 含めない: limit_approaching / burn_exhaustion（分単位で手遅れ）、
 * deepwork_cap_reached（中断させること自体が目的）、
 * deep_break_suggested（AI 待ち時間の活用提案＝deep でない）、
 * pomodoro 系（タイマー意味論）、watch_started 等の運用系。
 */
export const DEFERRABLE_TEMPLATES: ReadonlySet<string> = new Set([
  "weekly_pace_exceeded",
  "snowball_detected",
]);

/**
 * いま繰延を効かせるべきか。保護フェーズ中かつ phase が新鮮なときだけ true。
 * phase 未設定・stale・保護外（break/review）は false（＝即時通知に倒す）。
 */
export function isDeferralActive(
  phaseState: PhaseState | null,
  deferPhases: readonly Phase[],
  staleHours: number,
  now: Date,
): boolean {
  if (!phaseState) return false;
  // config.notify.deferDuringPhases は YAML から無検証でマージされうる。null/object を
  // 渡されても watch を落とさず「繰延しない」に倒す（安全側）。
  if (!Array.isArray(deferPhases)) return false;
  if (isPhaseStale(phaseState, staleHours, now)) return false;
  return deferPhases.includes(phaseState.phase);
}

export type DeferredEntry = {
  /** dedupBase:templateId（watch.ts の fired キーと同一） */
  key: string;
  templateId: string;
  severity: NotifySeverity;
  vars: Record<string, string | number>;
  /** ISO 文字列 */
  queuedAt: string;
};

export class DeferQueue {
  private entries: Map<string, DeferredEntry> = new Map();

  constructor(initial?: readonly DeferredEntry[]) {
    if (initial) for (const e of initial) this.entries.set(e.key, e);
  }

  get size(): number {
    return this.entries.size;
  }

  /**
   * 同 key は後着で置換（最新の vars/severity が勝つ）。ただし **queuedAt は初回 enqueue
   * 時刻を保持する**。条件が出続ける通知は毎 tick 再投入されるため、ここで queuedAt を
   * 更新すると経過時間が常に 0 に戻り、drainDue の maxDeferMin 安全弁と 24h TTL が
   * 永久に発火しなくなる（＝deep が延々続くと通知が握り潰される）。
   */
  enqueue(entry: Omit<DeferredEntry, "queuedAt">, now: Date): void {
    const existing = this.entries.get(entry.key);
    const queuedAt = existing ? existing.queuedAt : now.toISOString();
    this.entries.set(entry.key, { ...entry, queuedAt });
  }

  /**
   * 配送は「イベントベース」: deep 中に発火した通知を境界で振り返って届ける（現在も真かは
   * 問わない）。条件が境界前に解消（例: 週次 red→yellow）しても追い出しはしない。理由は
   * watch の advise が 1 tick に 1 件しか出さず（優先度最上位のみ）、低優先の条件が解消したか
   * を単独 tick から観測できないため。陳腐化は maxDeferMin（既定 60 分）安全弁で上限が付く。
   *
   * 配送すべき項目（send）と破棄すべき項目（dropped）を返し、両者をキューから取り除く。
   * - deferralActive=false（境界を越えた/保護解除）: TTL 内の全件を送る
   * - deferralActive=true（まだ保護中）: age>maxDeferMin の項目だけ送る（安全弁）
   * - age>TTL: 常に dropped（送らない）
   * まだ保護中で maxDefer 未満の項目はキューに残す。
   */
  drainDue(
    now: Date,
    deferralActive: boolean,
    opts: { maxDeferMin: number },
  ): { send: DeferredEntry[]; dropped: DeferredEntry[] } {
    const send: DeferredEntry[] = [];
    const dropped: DeferredEntry[] = [];
    const maxDeferMs = Math.max(0, opts.maxDeferMin) * 60_000;
    for (const e of this.entries.values()) {
      const age = now.getTime() - Date.parse(e.queuedAt);
      if (age > DEFER_TTL_MS) {
        dropped.push(e);
      } else if (!deferralActive || age > maxDeferMs) {
        send.push(e);
      }
      // else: 保護中かつ maxDefer 未満 → キューに残す
    }
    for (const e of send) this.entries.delete(e.key);
    for (const e of dropped) this.entries.delete(e.key);
    return { send, dropped };
  }

  toJSON(): DeferredEntry[] {
    return [...this.entries.values()];
  }

  /**
   * 永続データからの復元。不正データは黙って空キューに回復し、不正 entry は個別に捨てる
   * （observers/statusline_snapshot.ts の readSnapshot と同じ流儀）。
   */
  static fromJSON(v: unknown): DeferQueue {
    const q = new DeferQueue();
    if (!Array.isArray(v)) return q;
    for (const raw of v) {
      const e = parseEntry(raw);
      if (e) q.entries.set(e.key, e);
    }
    return q;
  }
}

/** 配送リクエスト（テンプレ + vars）。1 件は元テンプレ、2 件以上は deferred_digest に集約。 */
export type Delivery = {
  templateId: string;
  severity: NotifySeverity;
  vars: Record<string, string | number>;
};

/**
 * drain した send 群を配送リクエストに変換する。
 * - 0 件 → []
 * - 1 件 → 元テンプレのまま
 * - 2 件以上 → deferred_digest 1 通（deep 明けの通知の雨を防ぐ）
 * fired/cooldown の登録は各 send entry 単位で watch.ts が行う（本関数は表示だけ）。
 */
export function buildDeliveries(send: readonly DeferredEntry[]): Delivery[] {
  if (send.length === 0) return [];
  if (send.length === 1) {
    const e = send[0]!;
    return [{ templateId: e.templateId, severity: e.severity, vars: e.vars }];
  }
  const summary = send.map(summarizeEntry).join("\n");
  const severity = highestSeverity(send.map((e) => e.severity));
  return [{ templateId: "deferred_digest", severity, vars: { count: send.length, summary } }];
}

function summarizeEntry(e: DeferredEntry): string {
  switch (e.templateId) {
    case "weekly_pace_exceeded":
      return e.vars["reason"] === "cap_reached"
        ? `・週次枠を使い切り（消費 ${e.vars["used_pct"]}%）`
        : `・週次ペース超過（+${e.vars["pace_delta_pt"]}pt）`;
    case "snowball_detected":
      return `・雪だるま検出（${e.vars["cumulative_kt"]}k token）`;
    default:
      return `・${e.templateId}`;
  }
}

const SEVERITY_ORDER: readonly NotifySeverity[] = ["info", "nudge", "warn", "critical"];

function highestSeverity(list: readonly NotifySeverity[]): NotifySeverity {
  let idx = 0;
  for (const s of list) idx = Math.max(idx, SEVERITY_ORDER.indexOf(s));
  return SEVERITY_ORDER[idx]!;
}

function isSeverity(v: unknown): v is NotifySeverity {
  return v === "info" || v === "nudge" || v === "warn" || v === "critical";
}

function parseEntry(raw: unknown): DeferredEntry | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const key = o["key"];
  const templateId = o["templateId"];
  const severity = o["severity"];
  const queuedAt = o["queuedAt"];
  if (typeof key !== "string" || key.length === 0) return null;
  if (typeof templateId !== "string") return null;
  if (!isSeverity(severity)) return null;
  // queuedAt は「有限時刻に parse できる ISO」でなければ捨てる。
  // 不正だと drainDue の age が NaN になり、永久にキューに残る/破棄されない罠を防ぐ。
  if (typeof queuedAt !== "string" || !Number.isFinite(Date.parse(queuedAt))) return null;
  const rawVars = o["vars"];
  if (typeof rawVars !== "object" || rawVars === null || Array.isArray(rawVars)) return null;
  const vars: Record<string, string | number> = {};
  for (const [k, val] of Object.entries(rawVars)) {
    if (typeof val === "string" || typeof val === "number") vars[k] = val;
  }
  return { key, templateId, severity, vars, queuedAt };
}
