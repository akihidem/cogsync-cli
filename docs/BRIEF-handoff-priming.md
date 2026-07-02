# BRIEF: 閾値則ハンドオフ(#4) & プライミング提案(#5)（凍結仕様 v1）

> 根拠: cogsync 本体 §8.8 命題4（ハンドオフ閾値則）＝#4、§8.2 命題2 + §9 E2（アンカー・プライミング）＝#5。
> どちらも助言のみ（実行しない・AI を呼ばない・state を書かない）。判定の正本は純関数。時計は now 注入。

## 共通の設計判断（凍結）

1. 観測源は statusline snapshot（5h の resetsAt / usedPct）。ccusage は呼ばない（高速）。
2. snapshot 無し/`fiveHour` 欠落/stale → **unknown**（例外を投げない・助言できないと正直に返す）。
3. 数値パラメータは `thresholds` に足す（reservePhi と同じ流儀）。クランプ防御。
4. CLI と MCP tool は薄いラッパ。CLI は既定 1 行＋`--json`。exit code は常に 0（ゲートでなく助言）。

## #4 閾値則ハンドオフ

命題4: 主系（品質1）が τ に補充される。残タスク（価値 v）を副系（品質 q'<1）へ移すか待つか。
**移す ⟺ `delayCostPerMin·(τ−t) > h + (1−q')·v`**（左=待ちの費用 / 右=移行の費用）。

- `src/coach/handoff_rule.ts`（新規・純関数）
  - `type HandoffRuleInput = { minutesUntilReset: number | null; taskValue: number;
     secondaryQuality: number; handoffCost: number; delayCostPerMin: number }`
  - `type HandoffRuleVerdict = { recommend: "wait"|"handoff"|"unknown"; reason: string;
     waitCost: number | null; handoffCost: number; minutesUntilReset: number | null }`
  - `evaluateHandoffThreshold(input)`: minutesUntilReset null → unknown。
    taskValue/secondaryQuality(0-1)/handoffCost/delayCostPerMin/minutesUntilReset を防御クランプ（負値→0、q'→[0,1]）。
    境界（左==右）は **wait**（同値なら待つ＝保守側。移行の固定費を無駄にしない）。
  - `readHandoffRuleInput(config, now, taskValue?)`: snapshot の fiveHour.resetsAt から τ−t を出す IO アダプタ。
- MCP tool `should_i_handoff`（`taskValue?` 任意 number）。
- CLI `cogsync should-i-handoff [--value N] [--json]`：1 行（例 `handoff: 待ち費用 180 > 移行費用 25`）。
- config(thresholds): `handoffDelayCostPerMin`(1.0) / `handoffReconstructCost`(20=h) /
  `handoffSecondaryQuality`(0.9=q'・同格別ベンダ想定) / `handoffDefaultTaskValue`(50)。

## #5 プライミング提案

命題2 + E2: 5h ANCHORED 窓は最初の使用でエポックが開く。高価値 deep の前に軽い ping で窓を開けておくと
境界を帯内に置けて実効予算が最大 2 倍（E2）。実用の芯＝「今 deep を始めると窓が中途半端に尽きるか？
今プライミングすべきか？」を機械判定する。**cogsync は AI を呼ばないので提案のみ**（実 ping は人間/Routine）。

- `src/coach/priming.ts`（新規・純関数）
  - `type PrimingInput = { minutesUntilReset: number | null; fiveHourUsedPct: number | null;
     snapshotStale: boolean; deepDurationMin: number; primeIfUsedPct: number }`
  - `type PrimingVerdict = { action: "wait_for_reset"|"no_priming_needed"|"unknown"; reason: string;
     minutesUntilReset: number | null; fiveHourUsedPct: number | null }`
  - **[codex review 反映・力学訂正]** アクティブな窓は ping で前倒しリセットできない（ping は現行窓を
    消費するだけ）。ゆえに「アクティブ×消費済み」で prime_now を出すのは逆効果。action は
    `wait_for_reset | no_priming_needed | unknown`（prime_now は廃止）。窓の再タイミング（境界を帯内に
    置く二重バースト）は将来の deep 開始時刻が要るため v1 非スコープ。
  - 判定順序:
    1. データ無し（usedPct null or snapshotStale）→ unknown
    2. minutesUntilReset ≤ 0（窓が期限切れ/リセット済み）→ no_priming_needed（次の発話で新窓が開く＝自然なプライミング）
    3. usedPct < primeIfUsedPct（まだ新しい）→ no_priming_needed
    4. minutesUntilReset ≤ deepDurationMin（deep 中に自然リセット＝命題2 の二重バーストが自然に効く）→ no_priming_needed
    5. それ以外（アクティブ×消費済み・かつ deep 終了後までリセットしない）→ wait_for_reset
       （「アクティブな窓は前倒しできない。リセットまで待って新窓で始めるか、低予算を受け入れる」）
  - adapter は過去 reset を null 化せず実値（≤0 含む）を渡す。deepDurationMin/primeIfUsedPct はクランプ（負値→0）。
  - `readPrimingInput(config, now, deepDurationMin?)`: snapshot から組み立てる IO アダプタ。
- MCP tool `suggest_priming`（`deepDurationMin?` 任意 number）。
- CLI `cogsync suggest-priming [--deep-duration N] [--json]`。
- config(thresholds): `primeIfUsedPct`(50) / `primeDefaultDeepDurationMin`(120)。

## 非スコープ
- 実際の ping 送信（NF-2: cogsync は AI を呼ばない・提案のみ）
- 副系の実自動呼び出し（#4 は判定のみ・生成は既存 `cogsync handoff`）
- npm publish

## L0（合格基準・凍結）
1. `npm test` 全緑（既存 127 の回帰）＋ typecheck クリーン
2. #4 真理値表: 左>右→handoff / 左<右→wait / 左==右→wait（境界保守）/ minutesUntilReset null→unknown /
   q'=1（同品質）は h だけが障壁 / 各パラメータのクランプ（負値・q'>1）で例外なく妥当
3. #5 真理値表: データ無し→unknown / usedPct<閾値→no_priming / reset がセッション内→no_priming /
   消費進行×セッション後リセット→wait_for_reset / 期限切れ(reset≤0)→no_priming_needed / 境界（usedPct==閾値、reset==deepDuration）の扱い
4. recommend/action と補助数値の整合（unknown で waitCost=null 等）

## 検品
builder≠checker: L0 → codex review（ハング時 validator）→ 裁定修正 → 再確認 → PASS で commit。
