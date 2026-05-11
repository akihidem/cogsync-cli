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
 *   - permissionMode 別に "manual" / "auto" / "bypass" の 3 バケットへ分配する。
 *     manual = 通常 (default) モード、auto = acceptEdits / plan 系、bypass = bypassPermissions。
 *
 * 注: ai_busy 中の長時間放置は「人間は別作業に出ている = ブレイク取得済み」と扱える
 *     → CO-5 ブレイク提案の根拠になる。
 */

export type WorkState = "ai_busy" | "active" | "idle";
/** ディープワーク集計バケット。permissionMode のクラス分け。 */
export type PermissionBucket = "manual" | "auto" | "bypass";
export const ALL_BUCKETS: readonly PermissionBucket[] = ["manual", "auto", "bypass"];

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
 * バケット別 ms。
 */
export type DeepWorkBuckets = { manual: number; auto: number; bypass: number };

/**
 * 永続化フォーマット。
 *   - byDate          : ms 合計（旧フィールド、互換のため常に書き出す）
 *   - byDateBuckets   : バケット別 ms（新フィールド、書き出し時は常に同梱）
 * 旧バージョンの cogsync は byDate のみを読み取る。新バージョンは byDateBuckets を
 * 優先し、無ければ byDate を manual に寄せて取り込む。schema は 1 のまま据え置く。
 */
export type DeepWorkPersisted = {
  byDate: Record<string, number>;
  byDateBuckets?: Record<string, DeepWorkBuckets>;
};

/**
 * ディープワーク累積追跡。
 * watch ループからの「snapshot 列」を順に受け、active/ai_busy 状態の時間を
 * permissionMode バケット別に集計する。
 */
export class DeepWorkAccumulator {
  private accumByDate = new Map<string, DeepWorkBuckets>(); // YYYY-MM-DD → buckets ms
  private lastCheckAt: Date | null = null;
  private lastState: WorkState = "idle";
  private lastBucket: PermissionBucket = "manual";

  /**
   * 新しい状態と時刻を受け取り、前回からの差分を「人間がエンゲージしていた時間」として累積する。
   * 前回が active or ai_busy のときだけ加算。差分は前回観測時点の bucket に分配する。
   */
  feed(state: WorkState, at: Date = new Date(), bucket: PermissionBucket = "manual"): void {
    if (this.lastCheckAt) {
      const deltaMs = at.getTime() - this.lastCheckAt.getTime();
      if (deltaMs > 0 && (this.lastState === "active" || this.lastState === "ai_busy")) {
        const dateKey = ymd(this.lastCheckAt);
        const cur = this.accumByDate.get(dateKey) ?? emptyBuckets();
        cur[this.lastBucket] += deltaMs;
        this.accumByDate.set(dateKey, cur);
      }
    }
    this.lastCheckAt = at;
    this.lastState = state;
    this.lastBucket = bucket;
  }

  /** 当日の総分（manual+auto+bypass）。 */
  todayMin(now: Date = new Date()): number {
    const b = this.accumByDate.get(ymd(now));
    if (!b) return 0;
    return Math.round((b.manual + b.auto + b.bypass) / 60000);
  }

  /** 当日のバケット別分。 */
  todayBreakdown(now: Date = new Date()): { manual: number; auto: number; bypass: number; total: number } {
    const b = this.accumByDate.get(ymd(now)) ?? emptyBuckets();
    const manual = Math.round(b.manual / 60000);
    const auto = Math.round(b.auto / 60000);
    const bypass = Math.round(b.bypass / 60000);
    return { manual, auto, bypass, total: manual + auto + bypass };
  }

  snapshot(): { date: string; min: number; manual: number; auto: number; bypass: number }[] {
    return [...this.accumByDate.entries()]
      .map(([date, b]) => ({
        date,
        min: Math.round((b.manual + b.auto + b.bypass) / 60000),
        manual: Math.round(b.manual / 60000),
        auto: Math.round(b.auto / 60000),
        bypass: Math.round(b.bypass / 60000),
      }))
      .sort((a, b) => a.date.localeCompare(b.date));
  }

  /**
   * 永続化シリアライズ。
   * byDate（旧互換：ms 合計）と byDateBuckets（新：バケット別 ms）の両方を書き出す。
   */
  toJSON(): DeepWorkPersisted {
    const byDate: Record<string, number> = {};
    const byDateBuckets: Record<string, DeepWorkBuckets> = {};
    for (const [date, b] of this.accumByDate.entries()) {
      byDate[date] = b.manual + b.auto + b.bypass;
      byDateBuckets[date] = { ...b };
    }
    return { byDate, byDateBuckets };
  }

  /**
   * 両フォーマット対応で取り込む。
   * byDateBuckets があれば優先。なければ byDate の number を manual に寄せる。
   */
  loadFromJSON(data: DeepWorkPersisted | null): void {
    if (!data) return;
    const next = new Map<string, DeepWorkBuckets>();
    if (data.byDateBuckets) {
      for (const [date, val] of Object.entries(data.byDateBuckets)) {
        if (val && typeof val === "object") {
          next.set(date, {
            manual: typeof val.manual === "number" ? val.manual : 0,
            auto: typeof val.auto === "number" ? val.auto : 0,
            bypass: typeof val.bypass === "number" ? val.bypass : 0,
          });
        }
      }
    }
    // byDate は補完用: byDateBuckets に同じ日付があればスキップ
    if (data.byDate) {
      for (const [date, val] of Object.entries(data.byDate)) {
        if (next.has(date)) continue;
        if (typeof val === "number") {
          next.set(date, { manual: val, auto: 0, bypass: 0 });
        }
      }
    }
    this.accumByDate = next;
  }
}

function emptyBuckets(): DeepWorkBuckets {
  return { manual: 0, auto: 0, bypass: 0 };
}

function ymd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
