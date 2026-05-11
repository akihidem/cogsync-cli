# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.0.0-alpha.1] - 2026-05-11

### Added

- ディープワーク累積を Claude Code の permissionMode 別に 3 バケット (manual / auto / bypass) で集計。watch のステータス行に `dw=Nm(M:x/A:y/B:z) | mode=...` を表示。
- MCP `cogsync://state/deepwork` リソースに `manual` / `auto` / `bypass` の内訳を追加。
- 永続化フォーマットに `deepWork.byDateBuckets` を追加（schema=1 維持、旧 `byDate` と並走）。

### Changed

- `advise()` の dailyDeepWorkCap 判定は manual バケット単独で行うように変更（auto/bypass は除外）。

## [1.0.0-alpha.0] - 2026-05-11

### Added

- npm 配布対応: `bin/cogsync.js` エントリ追加、`tsx` を runtime 依存へ昇格。
- README を公開向けに再構成、`cogsync mcp` の登録方法を明示。
- GitHub Actions CI（Node 20、`typecheck` + `test`）。
- CHANGELOG / `prepublishOnly` で品質ゲート。

### Changed

- `package.json` から `private: true` を解除。`repository`/`bugs`/`keywords` を追加。
- CLI バージョン文字列を `0.5.0-alpha.0` → `1.0.0-alpha.0`。

## [0.5.0-alpha.0] - 2026-05-09

### Added

- MCP server (`cogsync mcp`) — read-only Resources。Claude Code 等から状態取得。
- MCP Tools: `set_phase` / `get_recommended_action` / `create_handoff`。
- MCP Prompts: `coach_phase_transition` / `coach_break_suggestion` ほか。

## [0.4.0-alpha.0]

### Changed

- UX 磨き — top session の揺らぎ、通知 spam 抑制、phase 失効ロジック。

## [0.3.0-alpha.0]

### Added

- `work_state` 推定、`DeepWorkAccumulator`、ブレイク提案、適応ポモドーロ。
- LLM ハンドオフ要約（Ollama）、スキル熟度推定、replay バックテスト。

## [0.2.0-alpha.0]

### Added

- フェーズ永続化、raw JSONL リーダ、雪だるま検出、`advise`。
- 通知の WSL → PowerShell トーストフォールバック。
- ccusage 観測の TTL キャッシュと in-flight dedup。
- バックテスト: snowball 閾値チューニング（デフォルト 150k）。

## [0.1.0-alpha.0]

### Added

- 初期 MVP: `ccusage` 経由で 5h ウィンドウ残量を取得、`status` / `watch` を実装。

[Unreleased]: https://github.com/akihidem/cogsync-cli/compare/v1.0.0-alpha.0...HEAD
[1.0.0-alpha.0]: https://github.com/akihidem/cogsync-cli/releases/tag/v1.0.0-alpha.0
