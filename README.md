# cogsync-cli

> cogsync MVP 実装：CLI + デスクトップ通知で「AI のリミット回復サイクル」と「人間の集中サイクル」を同期させ、フェーズに応じた指南とタイマー指示を出す。

## このリポジトリの位置付け

| | cogsync (調査) | **cogsync-cli (本リポ)** |
| --- | --- | --- |
| 役割 | 仕様策定・調査・コンセプト設計 | 実装。CLI で動く MVP |
| URL | github.com/akihidem/cogsync | github.com/akihidem/cogsync-cli |
| 状態 | v0.2 予備調査ノート | **v0.0 スケルトン**（責務定義のみ） |
| 公開 | private | private |

仕様の出典は cogsync 側の以下：

- [`product/concept.md`](https://github.com/akihidem/cogsync/blob/main/product/concept.md) — コア仮説とストーリーボード
- [`product/requirements.md`](https://github.com/akihidem/cogsync/blob/main/product/requirements.md) — 機能要件 ID（OB-/IN-/CO-/TI-/HO-）
- [`product/mvp-scope.md`](https://github.com/akihidem/cogsync/blob/main/product/mvp-scope.md) — 段階リリース計画
- [`product/coaching-prompts.md`](https://github.com/akihidem/cogsync/blob/main/product/coaching-prompts.md) — 通知文言テンプレ
- [`product/mcp-server-spec.md`](https://github.com/akihidem/cogsync/blob/main/product/mcp-server-spec.md) — v1.0 で目指す MCP サーバ仕様

## MVP（v0.1）スコープ

| ID | 機能 | 状態 |
| --- | --- | --- |
| OB-1 | ccusage / `~/.claude/projects/**/*.jsonl` から 5h ブロック取得 | 未着手 |
| OB-2 | 5h ウィンドウ残量と終了時刻予測 | 未着手 |
| IN-2 | 雪だるま効果検出 | 未着手 |
| IN-3 | リミット枯渇までの予測 | 未着手 |
| CO-3 | フェーズ移行時のハンドオフ・プロンプト生成 | 未着手 |
| CO-4 | リミット接近通知 | 未着手 |
| CO-5 | AI 処理中のディープ・ブレイク提案 | 未着手 |
| TI-1 | 適応的ポモドーロ（AI 処理時間で動的伸縮） | 未着手 |
| HO-1 | ハンドオフ・プロンプトのテンプレ提供 | 未着手 |

`docs/DESIGN.md` に内部設計、`src/` に責務スケルトンを配置済み。

## 技術スタック

| 層 | 採用 | 理由 |
| --- | --- | --- |
| ランタイム | Node.js 20+ | 既存環境で即動く。Bun への移行は v0.2 以降の検討事項 |
| TS 実行 | tsx 4 | 開発時は `npx tsx src/index.ts` で起動、ビルド不要 |
| 言語 | TypeScript（厳格モード） | ccusage / MCP SDK との親和性 |
| ストレージ | better-sqlite3 | 同期 API、依存少、組み込み（v0.2 で導入） |
| ファイル監視 | chokidar | クロスプラットフォーム（v0.2 で導入） |
| 通知 | node-notifier | macOS / Linux / Windows（v0.1 で導入） |
| 設定 | YAML（`js-yaml`） | 編集容易、コメント可 |
| MCP（v1.0） | `@modelcontextprotocol/sdk` | 公式 |

→ MVP は **CLI のみ・GUI なし**。GUI（Tauri）は MVP の有用性が確認できた v0.2 以降。
→ v0.1 は ccusage 子プロセス呼び出しのため、依存は最小（commander + js-yaml）。SQLite / 通知 / 監視は機能を追加する v0.2 以降に依存追加する。

## ディレクトリ構成

```
cogsync-cli/
├── README.md             # 本ファイル
├── package.json
├── tsconfig.json
├── docs/
│   ├── DESIGN.md         # 内部設計とデータフロー
│   └── ROADMAP.md        # MVP → v1.0 の段階計画
├── src/
│   ├── index.ts          # CLI エントリ（コマンド定義）
│   ├── config.ts         # 設定ファイル読み込み
│   ├── observers/        # 観測層（OB-*）
│   │   ├── ccusage.ts
│   │   └── claude_code.ts
│   ├── infer/            # 推論層（IN-*）
│   │   ├── window5h.ts
│   │   ├── snowball.ts
│   │   └── deepwork.ts
│   ├── coach/            # 指南層（CO-*）
│   │   ├── phase.ts
│   │   └── advise.ts
│   ├── timer/            # タイマー（TI-*）
│   │   └── adaptive.ts
│   ├── handoff/          # ハンドオフ（HO-*）
│   │   └── template.ts
│   ├── notify/           # OS 通知
│   │   └── desktop.ts
│   └── state/            # 永続化
│       └── store.ts
└── tests/                # 後で
```

## 起動コマンド

```bash
npm install                                        # 依存インストール
npm run status                                     # 現在の 5h ウィンドウ残量を 1 行表示（v0.1 実装済み）
npm run status -- --json                           # JSON 出力（プログラム消費用）
npm run watch                                      # 常駐モード（v0.1.x 実装予定）
npx tsx src/index.ts handoff                       # ハンドオフ・プロンプト生成（v0.2）
npx tsx src/index.ts phase set design              # フェーズ手動切替（v0.2）
npx tsx src/index.ts pomodoro start                # 適応的ポモドーロ開始（v0.3）
```

### 実出力例

```text
$ npm run status
Claude 5h ウィンドウ | 残り 4h16m | (終了 17:00) | 累計 2.81M | 8,636 tok/min
```

`残り` は **5h ウィンドウ終了時刻** と **現バーンレート想定の枯渇予測時刻** の早い方を採用。
枯渇予測が先に来た場合は `(枯渇予測 HH:MM - 現バーンレート想定)` と表示される。

## ライセンス

MIT を予定（v1.0 公開時に確定）。

## ステータス

**v0.1.0-alpha.0**：`cogsync status` が動作（ccusage 子プロセス呼び出しで 5h ウィンドウ残量を 1 行表示）。`watch` / `handoff` / `phase` / `pomodoro` は未実装。
