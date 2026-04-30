/**
 * infer: work_state
 *
 * JSONL の user/assistant タイムスタンプから「いま人間と AI のどちらが動いているか」を推定する。
 *
 * 状態:
 *   - "ai_busy": ユーザー投げ後にアシスタント応答待ち（最新 user.ts > 最新 assistant.ts、ギャップ短い）
 *   - "active":  ユーザーが応答を読んで次の入力を準備中、または応答直後 (最新 assistant.ts が直近 N 秒以内)
 *   - "idle":    どちらも止まっている (最後のイベントから M 分以上経過)
 *
 * ディープワーク累積:
 *   - active と ai_busy の合計時間を分単位で集計（人間がエンゲージしている時間）
 *   - 当日 (ローカルタイムゾーン) のみカウント
 *
 * 注: ai_busy 中の長時間放置は「人間は別作業に出ている = ブレイク取得済み」と扱える
 *     → CO-5 ブレイク提案の根拠になる。
 */

export type WorkState = "ai_busy" | "active" | "idle";

export type WorkSnapshot = {
  state: WorkState;
  /** 直近のユーザー入力時刻 */
  lastUserAt: Date | null;
  /** 直近のアシスタント応答時刻 */
  lastAssistantAt: Date | null;
  /** 状態判定の根拠 */
  reason: string;
};

export type ClassifyOptions = {
  /** active と判定する直近応答からの猶予秒 (デフォ 60) */
  activeGraceSec?: number;
  /** idle と判定する最終イベントからの経過分 (デフォ 5) */
  idleAfterMin?: number;
  /** ai_busy と判定する user 投擲からの最大待機分 (これを超えたら idle 扱い) */
  maxAiBusyMin?: number;
};

export function classifyWorkState(
  lastUserAt: Date | null,
  lastAssistantAt: Date | null,
  now: Date,
  opts: ClassifyOptions = {},
): WorkSnapshot {
  const activeGraceSec = opts.activeGraceSec ?? 60;
  const idleAfterMin = opts.idleAfterMin ?? 5;
  const maxAiBusyMin = opts.maxAiBusyMin ?? 10;

  const noEvents = !lastUserAt && !lastAssistantAt;
  if (noEvents) {
    return { state: "idle", lastUserAt, lastAssistantAt, reason: "no events recorded yet" };
  }

  const u = lastUserAt?.getTime() ?? 0;
  const a = lastAssistantAt?.getTime() ?? 0;
  const last = Math.max(u, a);
  const sinceLastMin = (now.getTime() - last) / 60000;

  if (sinceLastMin >= idleAfterMin) {
    return {
      state: "idle",
      lastUserAt,
      lastAssistantAt,
      reason: `last event ${sinceLastMin.toFixed(1)} min ago (>= ${idleAfterMin})`,
    };
  }

  if (u > a) {
    const waitMin = (now.getTime() - u) / 60000;
    if (waitMin <= maxAiBusyMin) {
      return {
        state: "ai_busy",
        lastUserAt,
        lastAssistantAt,
        reason: `user > assistant (waiting ${waitMin.toFixed(1)} min)`,
      };
    }
    return {
      state: "idle",
      lastUserAt,
      lastAssistantAt,
      reason: `user wait ${waitMin.toFixed(1)} min exceeded ${maxAiBusyMin} min`,
    };
  }

  // a >= u
  const sinceAssistantSec = (now.getTime() - a) / 1000;
  if (sinceAssistantSec <= activeGraceSec) {
    return {
      state: "active",
      lastUserAt,
      lastAssistantAt,
      reason: `assistant responded ${Math.round(sinceAssistantSec)}s ago`,
    };
  }
  return {
    state: "active",
    lastUserAt,
    lastAssistantAt,
    reason: `human reading/composing (${sinceAssistantSec.toFixed(0)}s since assistant)`,
  };
}

/**
 * ディープワーク累積追跡。
 * watch ループからの「snapshot 列」を順に受け、active/ai_busy 状態の時間を集計する。
 */
export class DeepWorkAccumulator {
  private accumMsByDate = new Map<string, number>(); // YYYY-MM-DD → ms
  private lastCheckAt: Date | null = null;
  private lastState: WorkState = "idle";

  /**
   * 新しい状態と時刻を受け取り、前回からの差分を「人間がエンゲージしていた時間」として累積する。
   * 前回が active or ai_busy のときだけ加算。
   */
  feed(state: WorkState, at: Date = new Date()): void {
    if (this.lastCheckAt) {
      const deltaMs = at.getTime() - this.lastCheckAt.getTime();
      if (deltaMs > 0 && (this.lastState === "active" || this.lastState === "ai_busy")) {
        const dateKey = ymd(this.lastCheckAt);
        this.accumMsByDate.set(dateKey, (this.accumMsByDate.get(dateKey) ?? 0) + deltaMs);
      }
    }
    this.lastCheckAt = at;
    this.lastState = state;
  }

  todayMin(now: Date = new Date()): number {
    return Math.round((this.accumMsByDate.get(ymd(now)) ?? 0) / 60000);
  }

  snapshot(): { date: string; min: number }[] {
    return [...this.accumMsByDate.entries()]
      .map(([date, ms]) => ({ date, min: Math.round(ms / 60000) }))
      .sort((a, b) => a.date.localeCompare(b.date));
  }

  /** 永続化用のシリアライズ／復元 */
  toJSON(): { byDate: Record<string, number> } {
    return { byDate: Object.fromEntries(this.accumMsByDate) };
  }
  loadFromJSON(data: { byDate?: Record<string, number> } | null): void {
    if (!data?.byDate) return;
    this.accumMsByDate = new Map(Object.entries(data.byDate));
  }
}

function ymd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
