# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.0.0-alpha.2] - 2026-05-12

### Fixed

- `findActiveSession` が複数 Claude Code ウィンドウ並行起動時に呼び出し元と無関係なセッションを誤検出し、`cumulative_uncached_tokens` が他セッション分を映していた問題を修正。`process.ppid` 経由で親 (Claude Code) の起動時刻を `/proc/<ppid>/stat` から算出し、各 JSONL の first_ts と 120 秒 tolerance で突き合わせて確実に同定する。解決失敗時 (非 Linux / standalone daemon) は従来の mtime-recent にフォールバック。

### Added

- `observers/claude_code.ts`: `readProcessStartMs(pid)` / `resolveSessionByParentPid(logDir, parentPid)` を公開 API として追加。
- `ActiveSessionPayload` に `resolution: "parent-pid" | "mtime-recent"` フィールドを追加（解決経路の観測性向上）。
- MCP サーバ起動時に boot / config-loaded / handlers-registered / connected の 4 段階を stderr に JSON line で記録。SIGTERM/SIGINT で明示 exit。最上位 `parseAsync().catch` で想定外例外を stderr に出して非ゼロ終了。

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
