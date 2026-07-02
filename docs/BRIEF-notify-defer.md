# BRIEF: 通知繰延キュー（凍結仕様 v1）

> 根拠: cogsync 本体 §9 E5（繰延で deep 割り込み 3.8→0 回/週、handback 遅延は平均 16 分）と
> Iqbal & Bailey 2008 / Kuo et al. IUI 2026（境界介入 engagement 52% vs タスク中 62% 却下）。
> deep（保護フェーズ）中の非緊急通知をフェーズ境界まで保留し、境界で 1 回にまとめて届ける。

## 設計判断（凍結）

1. **保護フェーズ** = `config.notify.deferDuringPhases`（既定 `["design", "implement"]`）。
   繰延が効くのは「現在 phase が保護リストに含まれ、かつ stale でない」とき。
   phase 未設定・stale・break/review は即時通知（従来どおり）。
2. **繰延対象テンプレ**は戦略系のみ: `weekly_pace_exceeded` と `snowball_detected`。
   （snowball は当該セッションの膨張がわずかに進む代償を許容して deep を守る側に倒す。）
   **繰延しない**: `limit_approaching` / `burn_exhaustion`（分単位で手遅れになる）、
   `deepwork_cap_reached`（中断させること自体が目的）、`deep_break_suggested`（AI 待ち時間の
   活用提案＝deep でない）、pomodoro 系（タイマー意味論）、watch_started 等の運用系。
3. **安全弁**: 保護フェーズが続いても `notify.maxDeferMin`（既定 60 分）を超えた項目は流す
   （黙って永遠に飲み込まない）。**TTL 24 時間**（定数）を超えた項目は送らず破棄
   （昨日の週次警告を今日届けない。まだ真なら watch が再発火する）。
4. **dedup/cooldown は送信時に登録**（キュー投入時ではない。投入時に登録すると
   破棄された通知が「送った扱い」になり永久に消えるため）。キュー内は
   `dedupBase:templateId` キーで重複排除し、後着の vars で置き換える。
5. **境界での配送**: drain した項目が 1 件なら元テンプレのまま送る。2 件以上なら
   新テンプレ `deferred_digest` 1 通に集約（deep 明けの通知の雨を防ぐ）。
6. **永続化**: キューは JsonStore の `PersistedState` にオプショナル field `deferQueue` として
   保存（watch 再起動で消えない）。旧 state ファイル（field なし）は空キューとして読める
   （後方互換。schema バージョンは上げない）。

## 実装スコープ

1. **`src/notify/defer.ts`（新規）**
   - `DEFERRABLE_TEMPLATES: ReadonlySet<string>`（上記 2 の集合。理由コメント付き）
   - `isDeferralActive(phaseState: PhaseState | null, deferPhases: Phase[], staleHours: number, now: Date): boolean`
   - `type DeferredEntry = { key: string; templateId: NotifyTemplateId; severity: ...; vars: Record<...>; queuedAt: string /* ISO */ }`
   - `class DeferQueue`:
     - `enqueue(entry)`（同 key は後着で置換）
     - `drainDue(now: Date, deferralActive: boolean, opts: { maxDeferMin: number }): { send: DeferredEntry[]; dropped: DeferredEntry[] }`
       （!active → 期限内全件 send / active → age > maxDeferMin のみ send。age > TTL(24h 定数) は dropped）
     - `size` / `toJSON()` / `static fromJSON(v: unknown)`（不正データは空キューに黙って回復。
       statusline_snapshot.ts の readSnapshot と同じ厳格検証の流儀: 不正 entry は個別に捨てる）
   - 時計は全メソッド引数 `now` 注入（Date.now() を内部で呼ばない。queuedAt 生成は enqueue の now 引数から）
2. **`src/watch.ts` 統合**
   - 送信点で `shouldDefer = DEFERRABLE_TEMPLATES.has(templateId) && isDeferralActive(...)` なら
     enqueue ＋ store 保存 ＋ `console.log` に「(繰延 queued)」。fired/cooldown 登録はしない。
   - 毎 tick: `drainDue` を評価。send が 1 件 → 元テンプレで notify。2 件以上 → `deferred_digest` で
     1 通（count と各件の要約行を vars で渡す）。**送信時に** 各 entry の fired key と cooldown を登録。
     dropped はログのみ。キュー変化時に store 保存。
   - watch 起動時に store からキュー復元。
3. **`src/notify/desktop.ts`**: `deferred_digest` テンプレ追加
   （title 例「cogsync — 繰延していた通知 N 件」、body は各件 1 行ずつ）。
4. **`src/config.ts`**: `notify.deferDuringPhases: Phase[]`（既定 ["design","implement"]）、
   `notify.maxDeferMin: number`（既定 60）。根拠コメント（§9 E5）。
5. **`src/state/store.ts`**: `PersistedState.deferQueue?: unknown`（型は defer.ts 側で検証）。
6. **`cogsync status`**: キューが非空なら「繰延通知 N 件保留中（境界で配送）」を 1 行追加。
   `--json` にも `deferredCount` を含める。
7. **README / CHANGELOG** 更新（繰延の設計判断 1〜5 を短く）。

## 非スコープ

- 繰延対象テンプレのユーザー設定化（v1 は定数）
- OS の Do-Not-Disturb 連動・カレンダー連動
- MCP からの手動 flush ツール
- npm publish

## L0（合格基準・凍結）

1. `npm test` 全緑（既存 85 の回帰含む）＋ `npm run typecheck` クリーン
2. `isDeferralActive`: 保護フェーズ×新鮮 → true / stale → false / null → false / break・review → false
3. `DeferQueue.enqueue`: 同 key 2 回 → 1 件（後着 vars が勝つ）
4. `drainDue` 境界: 解除 → 全件 send / active かつ age>maxDeferMin → send / age>24h → dropped（send に含まれない）/ 混在ケースで send と dropped の分離が正しい
5. digest 分岐: 2 件以上 → deferred_digest 1 通・1 件 → 元テンプレ（watch から切り出したテスト可能関数で検証）
6. 永続化: toJSON/fromJSON 往復一致・不正 entry の個別破棄・`deferQueue` field なしの旧 state → 空キュー

## 検品

builder ≠ checker: L0 → codex review（ハング時 validator）→ 裁定修正 → 再確認 → PASS で commit。
