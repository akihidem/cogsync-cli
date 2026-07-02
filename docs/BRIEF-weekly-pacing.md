# BRIEF: 週次 pacing（凍結仕様 v1）

> 根拠: cogsync（調査 repo）v0.3 の §9 E1（週次が binding。「木曜飢饉」は 5h 表示では防げない）と
> product/ops-playbook.md 機能翻訳 #1。観測の第一級ソースは **statusline JSON の
> `rate_limits.seven_day`（公式）**。契約 fixture: cogsync repo `data/statusline-rate-limits-sample.json`。

## 何を作るか（スコープ）

1. **`src/infer/weekly.ts`（新規・純関数）**
   - `RateLimitSnapshot`: statusline payload から抜いた
     `{ fiveHour?: { usedPct: number; resetsAtEpochSec: number }, sevenDay?: { usedPct: number; resetsAtEpochSec: number }, capturedAtEpochMs: number }`（生値を素直に保持）
   - `computeWeeklyStatus(snap, now: Date, opts): WeeklyStatus | null`
     - `windowStart = resetsAt − 7d`、`elapsedFraction = clamp01((now − windowStart) / 7d)`
     - `budgetLinePct = 100 × elapsedFraction`、`paceDeltaPct = usedPct − budgetLinePct`
     - `level`: `red` if `paceDeltaPct > redMarginPct（既定 100/7 ≈ 14.29）` または `usedPct >= 100` / `yellow` if `> 0` / else `green`
     - `projectedExhaustionAt`: 線形（rate = usedPct / elapsedFraction）で 100% 到達時刻。
       リセットより手前に来るときだけ非 null。`elapsedFraction = 0` や `usedPct = 0` は null（0 除算禁止）
     - `stale`: `(now − capturedAt) > staleAfterMin（既定 60 分）`。stale でも値は返すが呼び手が無視できるようフラグ
     - 時計は必ず引数 `now` で注入（テスト決定性）
   - `formatWeeklyLine(ws): string`（status 用 1 行）と `formatWeeklySegment(ws): string`（statusline 用の短い断片）

2. **`src/observers/statusline_snapshot.ts`（新規）**
   - `parseStatuslinePayload(jsonText: string): RateLimitSnapshot | null`
     - 厳格 parse: `rate_limits.five_hour / seven_day` の `used_percentage`・`resets_at` が
       有限 number のときだけ採用。片方欠落は許容（独立に欠落しうる、公式仕様）。両方欠落は null。
       文字列や NaN は捨てる。**評価・実行系の解釈は一切しない**（NF-4）
   - `persistSnapshot / readSnapshot`（`~/.local/state/cogsync/statusline.json`、XDG_STATE_HOME 尊重、
     tmp+rename の原子的書き込み、壊れたファイルは null で黙って回復）

3. **`cogsync statusline` サブコマンド（index.ts）**
   - stdin を全読み → parse → 有効なら persist → **1 行だけ stdout に出して exit 0**
     （Claude Code の statusline を壊さないことが最優先。parse 失敗でも固定文字列 `cogsync` を出して exit 0）
   - ccusage 呼び出し・ネットワーク・LLM 呼び出し禁止（毎メッセージ走るので速度最優先）
   - ハンドラは薄いラッパにし、中身は `runStatusline(input: string, nowなど): { line: string; persisted: boolean }`
     型のテスト可能な関数に切り出す
   - `cogsync status`: snapshot に sevenDay があれば週次行を追加表示（stale なら「(stale)」表示）。
     `--json` にも weekly を含める

4. **`src/coach/advise.ts`（加法的変更）**
   - `AdviseInput` に `weekly?: WeeklyStatus | null`
   - `Advice.action` union に `"throttle_batch"`、`templateId` union に `"weekly_pace_exceeded"` を追加
   - **優先順位**: 雪だるま(1) → 5h リミット接近(2) → **週次 red(新 3)** → deepwork cap(4) → AI 待ち(5) → continue
   - 発火条件: `weekly && !weekly.stale && weekly.level === "red"`。
     rationale に「+Xpt / 予算線 Y% / 消費 Z% / このままだと {projectedExhaustionAt の曜日時刻} に枯渇」。
     **yellow は通知しない**（うるさいコーチ禁止。continue に落とす）
   - watch デーモンと MCP の advise 呼び出し箇所で snapshot を読んで `weekly` を渡す
     （既存の notify テンプレ登録・cooldown の流儀に従う）

5. **`src/config.ts`**: `thresholds.weeklyRedMarginPct`（既定 14.3）と
   `thresholds.weeklySnapshotStaleMin`（既定 60）を追加（コメントに根拠: cogsync repo §9 E1）

6. **README**: statusline セットアップ節（`~/.claude/settings.json` の
   `"statusLine": { "type": "command", "command": "cogsync statusline" }` 例）と週次 pacing の説明、
   fixture 契約と「フィールドは独立に欠落しうる」注意

7. **CHANGELOG.md**: Unreleased に追記

## 非スコープ（やらない）

- snapshot 履歴からの EMA レート推定（v1 は単一 snapshot の線形で十分）
- codex/Gemini 等の他プロバイダ pacing
- 自動スロットリングの実行（助言のみ。実行ゲート MCP tool は次ブリーフ）
- 既存 statusline スクリプトへの passthrough / チェーン
- npm publish

## L0（合格基準・凍結）

1. `npm test` 全緑（既存 7 suite の回帰含む）＋ `npm run typecheck` クリーン
2. pacing 純関数の境界テスト: delta=0→green / +0.1→yellow / >14.29→red、
   枯渇予測の数値例（例: elapsed 50%・used 80% → windowStart+62.5% 地点、リセット前なので非 null。
   used 40% なら null）、`elapsedFraction=0`・`usedPct=0`・`now > resetsAt` で例外なし
3. parse の敵対テスト: 正常 fixture / five_hour のみ / seven_day のみ / 型不正（文字列・NaN）/
   壊れ JSON / 空 stdin → クラッシュせず正しく null or 部分採用。persist→read の往復と破損ファイル回復
4. advise 優先順位テスト: 雪だるま > 5h接近 > 週次red > deepwork cap の順序、
   yellow は continue、**stale の red は発火しない**
5. `runStatusline` テスト: 正常入力→ 1 行出力＋persist、壊れ入力→ フォールバック 1 行＋exit 0 相当
   （throw しない）

## 検品

builder ≠ checker: 実装後に L0 を回し、codex review（不調時は validator）→ 指摘裁定 → 修正 → 再確認。
