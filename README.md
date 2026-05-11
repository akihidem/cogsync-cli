# cogsync

> AI のリミット回復サイクル（Claude Code の 5h ブロック）と人間の集中サイクルを同期させる CLI コーチ。CLI と MCP サーバの両方で動作する。

[![CI](https://github.com/akihidem/cogsync-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/akihidem/cogsync-cli/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/cogsync-cli/alpha.svg)](https://www.npmjs.com/package/cogsync-cli)
[![license](https://img.shields.io/npm/l/cogsync-cli.svg)](./LICENSE)

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
| `cogsync status [--json]` | 5h ウィンドウ残量を 1 行表示 |
| `cogsync watch [--once]` | 常駐ポーリング・通知 |
| `cogsync phase set <design\|implement\|review\|break>` | フェーズ手動切替 |
| `cogsync phase get` | 現フェーズ表示 |
| `cogsync pomodoro start [--focus 25] [--break 5] [--cycles 4] [--no-adaptive]` | 適応ポモドーロ |
| `cogsync handoff [--title] [--goal] [--state] [--next] [--llm]` | ハンドオフ雛形を生成・クリップボード |
| `cogsync skill` | 過去 30 日の並列稼働分布から熟度を推定 |
| `cogsync config` | 解決後の設定をダンプ |
| `cogsync mcp` | MCP stdio サーバ起動 |

`--help` で詳細オプションを表示。

## アーキテクチャ

```
src/
├── index.ts          # CLI エントリ
├── config.ts         # 設定読み込み
├── observers/        # 観測層（ccusage / claude_code raw JSONL）
├── infer/            # 推論層（window5h / snowball / deepwork）
├── coach/            # 指南層（phase / advise）
├── timer/            # 適応ポモドーロ
├── handoff/          # ハンドオフ雛形 + Ollama 要約
├── notify/           # OS 通知（WSL→PowerShell トースト含む）
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
