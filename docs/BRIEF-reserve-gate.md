# BRIEF: 自律バッチ用リザーブゲート（凍結仕様 v1）

> 根拠: cogsync 本体 §8.7 P1 reserve(φ)（在席予定のため各窓の φ·C を確保・自律バッチは残量>φ·C のときだけ）と
> §9 E3（φ=0.3 で在席飢餓を大幅減）＋ ops-playbook 機能翻訳 #3。
> cron/banto 等の自律エージェントが「今バッチを走らせてよいか」を**自主規制**するための口。

## 設計判断（凍結）

1. **判定の正本は純関数** `evaluateReserveGate(input)`（coach 層）。MCP tool と CLI は薄いラッパ。
2. **観測源**: 5h 残量は statusline snapshot の `fiveHour.usedPct`（公式ローカル）。
   remaining_fraction = 1 − usedPct/100。snapshot が無い/`fiveHour` 欠落/stale なら 5h は測れない。
3. **判定ロジック（順序固定）**:
   1. weekly が red かつ fresh → **hold**（週次が binding。§8.5。famine リスク・確定）
   2. 5h が測れない（usedPct=null or snapshot stale）→ **unknown**。allow は `onUnknown` 設定で決まる
   3. projected = remaining_fraction − (estimatedUsagePct ?? 0)/100。projected < reservePhi → **hold**（リザーブ侵食）
   4. それ以外 → **allow**
4. **onUnknown 既定 = "allow"**: statusLine 未設定で全バッチを黙って止めると、
   「自動化が手動を呼ぶ」最悪 UX（operator が最も嫌う）になる。慎重運用は設定で "deny" に倒せる。
   ただし weekly red は onUnknown に関係なく hold（データがある方の確定シグナルは効かせる）。
5. **exit code（CLI）**: allow → 0 / hold・unknown-deny → 1。
   shell が `cogsync can-i-run-batch && ./batch.sh` で自主規制できることが最重要。
6. **副作用なし・読み取り専用**（phase を変えない・通知しない・state を書かない）。時計は now 注入。

## 実装スコープ

1. **`src/coach/reserve.ts`（新規・純関数）**
   - `type ReserveGateInput = { fiveHourUsedPct: number | null; snapshotStale: boolean;
      weeklyLevel: "green"|"yellow"|"red"|null; weeklyStale: boolean; reservePhi: number;
      estimatedUsagePct?: number; onUnknown: "allow"|"deny" }`
   - `type ReserveVerdict = { allow: boolean; verdict: "allow"|"hold"|"unknown"; reason: string;
      fiveHourRemainingPct: number | null; reservePct: number;
      blockedBy: ("five_hour_reserve"|"weekly_red")[] }`
   - `evaluateReserveGate(input): ReserveVerdict`。reservePhi は [0,1] にクランプ、
     usedPct は [0,100] にクランプ（防御）。estimatedUsagePct 負値は 0 扱い。reason は日本語 1 行。
3. **MCP tool `can_i_run_batch`（tools.ts）**
   - inputSchema: `{ estimatedUsagePct?: number(0-100 の任意。バッチが 5h 窓を追加消費する見込み%) }`
   - snapshot を読み、`computeWeeklyStatus` で weekly level、`capturedAt` から snapshotStale を出し、
     config の reservePhi / reserveGateOnUnknown を渡して evaluate。JSON（verdict オブジェクト）を返す。
   - annotations: readOnlyHint: true, destructiveHint: false。
   - description に「自律バッチ（cron/夜間処理）の実行可否を、在席時間のための 5h リザーブと週次枠から判定」と明記。
4. **CLI `cogsync can-i-run-batch`（index.ts）**
   - `--json`（verdict オブジェクト全体）/ `--estimated-usage-pct <n>`。
   - 非 json は 1 行（例 `allow: 5h 残 62% ≥ リザーブ 30%` / `hold: 週次 red（famine リスク）`）。
   - **process.exit(allow ? 0 : 1)**。ccusage は呼ばない（snapshot だけ・高速）。
5. **`src/config.ts`**: `thresholds.reservePhi`（既定 0.3・根拠 §9 E3）、
   `thresholds.reserveGateOnUnknown: "allow"|"deny"`（既定 "allow"）。
6. **`src/mcp/resources.ts` は変更しない**（新規リソースは足さない。tool のみ）。
7. **README / CHANGELOG** 更新（cron 連携例 `cogsync can-i-run-batch && ./nightly.sh` を含める）。

## 非スコープ

- reservePhi の phase 別変動（v1 は単一値）
- 実行の強制（あくまで助言＋exit code。バッチを殺しはしない）
- 週次 yellow での hold（yellow は通さない＝allow。うるさくしない。red のみ hold）
- npm publish

## L0（合格基準・凍結）

1. `npm test` 全緑（既存 108 の回帰含む）＋ `npm run typecheck` クリーン
2. evaluateReserveGate 真理値表:
   - weekly red fresh → hold（onUnknown・5h に関係なく）/ weekly red stale → red 無視
   - 5h remaining ≥ φ → allow / < φ → hold（blockedBy five_hour_reserve）
   - estimatedUsagePct を引いて φ を割る → hold / 引いても余る → allow
   - usedPct=null → unknown、onUnknown=allow で allow / deny で hold
   - snapshot stale → unknown（同上）
   - 境界: remaining == φ ちょうどは allow（< で hold）
3. クランプ: reservePhi>1 や <0、usedPct>100 や <0、estimatedUsagePct<0 でも例外なく妥当な verdict
4. blockedBy と allow の整合（allow=true なら blockedBy 空／verdict と allow の対応）

## 検品

builder≠checker: L0 → codex review（ハング時 validator）→ 裁定修正 → 再確認 → PASS で commit。
