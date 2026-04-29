# cogsync-cli ロードマップ

## v0.0 — スケルトン（現在地）
- ディレクトリ構成、package.json、責務コメント、設計ドキュメント
- 動作するコードはまだない

## v0.1 — 観測 + 通知（最小動作）
**ゴール**：1 日使って自分自身に効くか検証できる状態。

- [ ] CLI: `cogsync status` でリミット残量を 1 行表示
- [ ] CLI: `cogsync watch` 常駐モード。30 秒ポーリングで観測
- [ ] OB-1: ccusage の MCP 経由 or JSONL 直読
- [ ] OB-2: 5h ウィンドウ残量予測（直近 30 分の消費速度ベース）
- [ ] CO-4: リミット 15 分前に通知（テンプレ `limit_approaching`）
- [ ] state/store: SQLite 初期化、token_events 記録
- [ ] config: YAML 読み込み

## v0.2 — フェーズ切替 + ハンドオフ
- [ ] CO-3 / HO-1: `cogsync handoff` でテンプレ生成 + クリップボード
- [ ] phase 手動切替: `cogsync phase set design`
- [ ] CO-1: フェーズに応じたモデル提案
- [ ] IN-2: 雪だるま検出と通知（`snowball_detected` テンプレ）

## v0.3 — 適応タイマー + スキル熟度
- [ ] TI-1: 適応的ポモドーロ。AI 処理中は自動延長
- [ ] IN-4: スキル熟度の自動推定（差し戻し率／レビュー時間から）
- [ ] CO-2: スキル熟度 × タスク粒度 から並列数提案
- [ ] CO-5: AI 処理時間から「ディープ・ブレイク」提案

## v1.0 — MCP サーバ化
- [ ] cogsync を MCP サーバとして起動するモード
- [ ] `cogsync://state/*` リソースの公開
- [ ] AI 側からのツール呼び出し（プロンプトインジェクション対策付き）
- [ ] ドキュメント整備して OSS 公開判断

## v2.0 以降（仮）
- GUI（Tauri 候補）
- チーム共有モード
- local-llm-pkg のオプションパッケージ化
