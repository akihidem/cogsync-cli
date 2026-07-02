# cogsync

> AI のリミット回復サイクル（Claude Code の 5h ブロック）と人間の集中サイクルを同期させる CLI コーチ。CLI と MCP サーバの両方で動作する。

[![CI](https://github.com/akihidem/cogsync-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/akihidem/cogsync-cli/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/cogsync-cli/alpha.svg)](https://www.npmjs.com/package/cogsync-cli)
[![license](https://img.shields.io/npm/l/cogsync-cli.svg)](./LICENSE)

> 📘 **はじめての方は [使い方ガイド `docs/USAGE.md`](./docs/USAGE.md) を先に読んでください。**
> 5 分セットアップ・毎日の使い方（時系列）・コマンド逆引き・困ったとき、を平易にまとめています。
> 以下の README は仕様リファレンスです。

## 何をするか

Claude Code を長時間使う日、5h リミットの残量・雪だるま化したセッション・ディープワーク累積を観測して、フェーズに応じた指南（design / implement / review / break）と適応ポモドーロを出す。MCP サーバとしても起動でき、Claude Code 側から直接フェーズ切替・ハンドオフ生成ができる。

- **観測**: `ccusage` の 5h ブロック + Claude Code raw JSONL を継続ポーリング
- **推論**: 残量・枯渇予測・雪だるま検出・並列稼働分布から推奨フェーズを決定
- **指南**: デスクトップ通知（macOS / Linux / Windows / WSL→PowerShell トースト）
- **タイマー**: 適応ポモドーロ（AI 処理時間に応じて伸縮）
- **ハンドオフ**: フェーズ移行時のプロンプト雛形をクリップボードへ
- **MCP**: stdio で Resources / Tools / Prompts を Claude Code に公開

## 必要環境

- Node.js 20+
- [`ccusage`](https://github.com/ryoppippi/ccusage) が `npx ccusage` で呼べる状態（Claude Code 利用者ならまず入っている）

## インストール

```bash
# グローバルインストール（α 版）
npm install -g cogsync-cli@alpha

# または npx
npx cogsync-cli@alpha status
```

## クイックスタート

```bash
cogsync status                # 現在の 5h ウィンドウ残量を 1 行表示
cogsync status --json         # JSON 出力（他プログラムから消費）
cogsync watch                 # 常駐モード。閾値超えで OS 通知
cogsync phase set design      # 手動フェーズ切替
cogsync pomodoro start        # 適応ポモドーロ
cogsync handoff --title 認証 --goal "JWT を分離" --next "Cookie 経路を extract"
cogsync mcp                   # MCP サーバ起動（stdio）
```

実行例:

```text
$ cogsync status
Claude 5h ウィンドウ | 残り 4h16m | (終了 17:00) | 累計 2.81M | 8,636 tok/min
```

`残り` は **5h ウィンドウ終了時刻** と **現バーンレート想定の枯渇予測時刻** の早い方を採用。
枯渇予測が先に来た場合は `(枯渇予測 HH:MM - 現バーンレート想定)` を表示する。

## 週次 pacing（statusline 連携）

5h ウィンドウの表示だけでは「木曜飢饉」（週の後半でリミットが尽きる）を防げない。Claude Code の
`statusLine` フックに `cogsync statusline` を登録すると、メッセージ毎に渡ってくる `rate_limits`
（5h / 7日の使用率）を観測・永続化し、週次の消費ペースが「予算線」（1 週間を均等消費した場合の
理論値）を超えていないかを毎回判定できるようになる。

`~/.claude/settings.json` に登録:

```json
{
  "statusLine": {
    "type": "command",
    "command": "cogsync statusline"
  }
}
```

登録すると:

- 毎メッセージ、Claude Code から渡される JSON（`rate_limits.five_hour` / `seven_day`）を
  `~/.local/state/cogsync/statusline.json` に永続化する（ccusage 呼び出し・ネットワーク通信なし。高速）
- `cogsync status` に週次行が追加表示される（例:
  `週次ペース red | 消費 78.0% | 予算線 65.3% (+12.7pt) | 枯渇予測 木 14:00`）。永続化データが
  古い（既定 60 分超）場合は行末に `(stale)` が付く。`--json` にも `weekly` フィールドとして含まれる
- `cogsync watch` / MCP `get_recommended_action` が週次 red（予算線を大きく超過）を検知すると
  `throttle_batch` を助言する（通知テンプレ `weekly_pace_exceeded`）。予算線をわずかに超えただけの
  yellow は通知しない（うるさいコーチにしない）

**フィールドは独立に欠落しうる**: `rate_limits.five_hour` と `seven_day` は Claude Code 側の仕様上、
互いに独立に欠落しうる（例: 5h のみ・7日のみが届くこともある）。cogsync はどちらか一方が有効なら
受理し、両方欠落・型不正のときのみ無視する。契約 fixture:
[cogsync repo `data/statusline-rate-limits-sample.json`](https://github.com/akihidem/cogsync)。

## 通知の繰延（deep 中は境界まで待つ）

`cogsync watch` は、設計・実装フェーズ（`notify.deferDuringPhases`、既定 `["design","implement"]`）の
最中は、戦略系の通知（週次ペース超過・雪だるま検出）を**フェーズ境界まで保留**する。深い集中の
最中に割り込まないための設計で、境界を越えたら保留分をまとめて 1 通で届ける（cogsync repo §9 E5＝
繰延で deep 中の割り込みを 0 化、代償は handback 遅延 平均 16 分）。

- **繰延するのは戦略系だけ**: 週次ペース・雪だるまのみ。リミット接近／枯渇予測（分単位で手遅れ）、
  ディープワーク上限（中断させること自体が目的）、ポモドーロ系は繰延せず即時通知する。
- **安全弁**: 保護フェーズが続いても `notify.maxDeferMin`（既定 60 分）を超えた項目は流す。
  24 時間を超えた項目は送らず破棄する（昨日の警告を今日届けない。まだ真なら再検知される）。
- 保留中はキューを `state.json` に永続化するので `watch` を再起動しても消えない。
  `cogsync status` に保留件数が表示される。
- `phase` が未設定・stale・`review`／`break` のときは繰延せず即時通知（保護は明示的に集中中のときだけ）。

`cogsync phase set implement` などでフェーズを宣言しておくと繰延が効く（宣言が無ければ即時通知のまま）。

## 自律バッチのリザーブゲート（cron/banto の自主規制）

夜間の自律バッチ（cron・自律エージェント）が subscription の 5h 枠を食い尽くすと、日中の対話が
飢える。`cogsync can-i-run-batch` は「今バッチを走らせてよいか」を判定し、**exit 0（allow）/
1（hold）**を返すので、shell からそのままゲートにできる:

```bash
# 5h 残量が在席リザーブ（既定 φ=0.3）を割らず、週次も red でなければ実行
cogsync can-i-run-batch && ./nightly-batch.sh

# バッチの 5h 消費見込みを見込んで判定（残量 − 見込み ≥ φ か）
cogsync can-i-run-batch --estimated-usage-pct 40 && ./heavy-job.sh
```

判定の内訳:

- **週次 red** なら hold（週次が binding。famine リスク）。
- **5h 残量が φ（`thresholds.reservePhi`、既定 0.3＝30%）を割る**なら hold（在席時間のリザーブを守る）。
- statusLine 未設定などで 5h 残量が観測できないときは `unknown`。既定は通す（`allow`）が、
  `thresholds.reserveGateOnUnknown: deny` で止める側に倒せる。
- 副作用なし・ccusage 呼び出しなし（statusline snapshot だけを見るので高速）。

MCP から使う場合は tool `can_i_run_batch`（`estimatedUsagePct?` 任意）が同じ verdict を JSON で返す。
`cogsync can-i-run-batch --json` でも同じオブジェクトが得られる。

> 前提: 5h/週次の観測には statusLine 連携（上記「週次 pacing」）が要る。未設定だと `unknown` になる。

## 待つ / 移す / 開き直す（ハンドオフ閾値・プライミング）

- **`cogsync should-i-handoff [--value N]`**: 5h 窓が尽きたとき、補充を待つか副系（別ベンダの
  同格モデル等）へハンドオフするかを閾値則で判定する（命題4）。待ちの費用
  `遅延費用/分 × 補充までの分` が移行の費用 `固定費 h + (1−q')·タスク価値` を上回るなら `handoff`。
  補充が近い（τ が小さい）ほど `wait`、遠いほど `handoff`。h はハンドオフ・テンプレの質で下げられる
  （＝`cogsync handoff` の雛形を整えるほど移行が有利になる）。
- **`cogsync suggest-priming [--deep-duration N]`**: 集中作業を始める前に、5h 窓の状態から
  待つべきかを判定する（命題2/E2）。5h ANCHORED 窓は最初の使用でエポックが開き 5h 固定で、
  **アクティブな窓は ping を送っても前倒しリセットできない**（ping は現行窓を消費するだけ）。
  そのため、アクティブな窓が既に消費済みで deep 終了後までリセットしないときは `wait_for_reset`
  （リセットまで待って新窓で deep を始めるか、低予算セッションを受け入れる）。窓が期限切れなら
  次の発話が新窓を開く＝自然なプライミングなので不要、窓がまだ新しい／セッション中に自然リセット
  するなら不要。**cogsync は AI を呼ばないので提案のみ**。
  （窓の再タイミング＝境界を deep 帯内に置く二重バーストは、将来の deep 開始時刻が要るため v1 では未対応。）

どちらも副作用なし・助言のみ（exit 0）。5h の観測には statusLine 連携が要る（未設定だと `unknown`）。

## MCP サーバとして使う

Claude Code の `~/.claude/settings.json` などに登録:

```json
{
  "mcpServers": {
    "cogsync": {
      "command": "cogsync",
      "args": ["mcp"]
    }
  }
}
```

提供する Resource / Tool / Prompt の一覧は [`docs/MCP.md`](./docs/MCP.md) 参照。代表的なものは:

- Resource: `cogsync://state/window5h`, `cogsync://state/phase`, `cogsync://state/deepwork`
- Tool: `set_phase`, `get_recommended_action`, `create_handoff`
- Prompt: `coach_phase_transition`, `coach_break_suggestion`

## 設定

`~/.config/cogsync/config.yaml` で上書き可能（`--config <path>` / `COGSYNC_CONFIG` 環境変数でも可）。

```yaml
profile:
  parallelCapacity: 3
  dailyDeepWorkCapMin: 240
thresholds:
  snowballToken: 80000
  limitWarnMin: 15
notify:
  tone: neutral
  quietDuringAiWork: true
observers:
  ccusage:
    enabled: true
    pollingSec: 30
```

## 主なコマンド

| コマンド | 役割 |
| --- | --- |
| `cogsync status [--json]` | 5h ウィンドウ残量＋週次ペース＋繰延保留件数を表示 |
| `cogsync statusline` | Claude Code `statusLine` フック用。rate_limits を観測・永続化し 1 行返す |
| `cogsync watch [--once]` | 常駐ポーリング・通知 |
| `cogsync phase set <design\|implement\|review\|break>` | フェーズ手動切替 |
| `cogsync phase get` | 現フェーズ表示 |
| `cogsync pomodoro start [--focus 25] [--break 5] [--cycles 4] [--no-adaptive]` | 適応ポモドーロ |
| `cogsync handoff [--title] [--goal] [--state] [--next] [--llm]` | ハンドオフ雛形を生成・クリップボード |
| `cogsync skill` | 過去 30 日の並列稼働分布から熟度を推定 |
| `cogsync config` | 解決後の設定をダンプ |
| `cogsync can-i-run-batch [--json] [--estimated-usage-pct N]` | 自律バッチ実行可否を判定（exit 0=allow/1=hold）。cron の自主規制用 |
| `cogsync should-i-handoff [--value N] [--json]` | 5h 補充を待つか副系へ移すかを閾値則で判定（命題4） |
| `cogsync suggest-priming [--deep-duration N] [--json]` | deep 前に 5h 窓をプライミングすべきか判定（命題2/E2） |
| `cogsync mcp` | MCP stdio サーバ起動 |

`--help` で詳細オプションを表示。

## アーキテクチャ

```
src/
├── index.ts          # CLI エントリ
├── config.ts         # 設定読み込み
├── observers/        # 観測層（ccusage / claude_code raw JSONL / statusline snapshot）
├── infer/            # 推論層（window5h / snowball / deepwork / weekly pacing）
├── coach/            # 指南層（phase / advise）
├── timer/            # 適応ポモドーロ
├── handoff/          # ハンドオフ雛形 + Ollama 要約
├── notify/           # 通知層（OS 通知/WSL→PowerShell トースト・defer 繰延キュー）
├── state/            # フェーズ・累積の永続化
└── mcp/              # MCP server (resources / tools / prompts)
```

詳細は [`docs/DESIGN.md`](./docs/DESIGN.md) / [`docs/ROADMAP.md`](./docs/ROADMAP.md)。

## 開発

```bash
git clone https://github.com/akihidem/cogsync-cli.git
cd cogsync-cli
npm install
npm run typecheck
npm test
npm run dev -- status   # tsx 経由でローカル実行
```

## ステータス

`v1.0.0-alpha`: CLI 全コマンド + MCP Resources / Tools / Prompts が動作。安定版（v1.0.0）は実利用フィードバックを経て確定する。

## ライセンス

[MIT](./LICENSE)
