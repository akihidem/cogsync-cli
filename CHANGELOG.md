# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.0.0-alpha.3] - 2026-07-02

### Added

- 週次 pacing: `cogsync statusline` サブコマンドを追加。Claude Code の `statusLine` フックから
  `rate_limits`（statusline JSON）を観測・永続化し、週次の消費ペースが予算線（1 週間均等消費の
  理論値）を超過していないかを判定する（「木曜飢饉」対策。cogsync repo §9 E1）。
- `src/infer/weekly.ts`: `computeWeeklyStatus` / `formatWeeklyLine` / `formatWeeklySegment` /
  `formatWeekdayHHMM`（純関数、時刻は引数 `now` で注入）。
- `src/observers/statusline_snapshot.ts`: `parseStatuslinePayload`（厳格 parse。five_hour /
  seven_day は独立に欠落を許容）/ `persistSnapshot` / `readSnapshot`（`~/.local/state/cogsync/statusline.json`、
  XDG_STATE_HOME 尊重、原子的書き込み）/ `runStatusline`。
- `cogsync status` に週次行を追加表示（stale なら `(stale)` 表示）。`--json` にも `weekly` を含める。
- `advise()` の優先順位に「3: 週次 red」を追加（雪だるま・5h 接近リミットの次点、deepwork cap の
  手前）。`throttle_batch` アクション・`weekly_pace_exceeded` テンプレを発火。stale な snapshot や
  yellow レベルでは発火しない。`watch` デーモン・MCP `get_recommended_action` の両方から発火する。
- `config.ts`: `thresholds.weeklyRedMarginPct`（既定 14.3）/ `thresholds.weeklySnapshotStaleMin`
  （既定 60 分）を追加。
- 通知繰延キュー: deep（保護フェーズ）中の戦略系通知（週次ペース・雪だるま）をフェーズ境界まで
  保留し、境界でまとめて届ける（cogsync repo §9 E5＝deep 中の割り込みを 0 化）。
  - `src/notify/defer.ts`: `DeferQueue`（enqueue は同 key を後着で置換／drainDue は
    「境界越えで全件送信・安全弁 maxDeferMin 超過で送信・TTL 24h 超で破棄」）、
    `isDeferralActive`（保護フェーズ×新鮮のみ true）、`buildDeliveries`（2 件以上は
    `deferred_digest` 1 通に集約）。時刻は全て引数 `now` 注入。永続データの不正 entry は個別に破棄。
  - 繰延対象は戦略系のみ（`weekly_pace_exceeded` / `snowball_detected`）。時間クリティカル系
    （`limit_approaching` / `burn_exhaustion`）・中断が目的の `deepwork_cap_reached`・
    pomodoro 系・運用系は即時のまま。
  - `watch`: fired/cooldown は「送信時」に登録（キュー投入時に登録すると TTL 破棄された通知が
    永久に消える）。キューは `state.json` の `deferQueue` に永続化（再起動で消えない・旧 state 後方互換）。
  - `config.ts`: `notify.deferDuringPhases`（既定 `["design","implement"]`）/ `notify.maxDeferMin`（既定 60）。
  - `cogsync status`: 保留件数を 1 行表示。`--json` に `deferredCount`。
- リザーブゲート: 自律バッチ（cron/banto）が「今バッチを走らせてよいか」を自主規制する口
  （cogsync repo §8.7 P1 reserve(φ)・§9 E3）。在席時間のための 5h 窓リザーブ（残量が φ を割らないか）と
  週次枠（red なら famine リスク）を見て allow / hold / unknown を返す。
  - `src/coach/reserve.ts`: `evaluateReserveGate`（純関数・時計注入）＋ `readReserveInput`（snapshot IO アダプタ）。
    判定順序は weekly red（確定 hold）→ 5h 測定不能（unknown）→ 5h リザーブ侵食（hold）→ allow。
  - MCP tool `can_i_run_batch`（`estimatedUsagePct?` 任意）。
  - CLI `cogsync can-i-run-batch [--json] [--estimated-usage-pct N]`：**exit 0(allow)/1(hold)**。
    shell が `cogsync can-i-run-batch && ./nightly.sh` で自主規制できる（ccusage 不使用・高速）。
  - `config.ts`: `thresholds.reservePhi`（既定 0.3）/ `thresholds.reserveGateOnUnknown`（既定 `allow`）。
- 閾値則ハンドオフ: 5h 窓の補充を待つか副系へハンドオフするかを命題4で判定
  （`delayCost·(τ−t) > h + (1−q')·v` なら handoff。cogsync repo §8.8）。
  `src/coach/handoff_rule.ts`（純関数＋IO アダプタ）、MCP tool `should_i_handoff`、
  CLI `cogsync should-i-handoff [--value N] [--json]`。境界（同値）は wait（保守）。
  config: `thresholds.handoffDelayCostPerMin`(1.0)/`handoffReconstructCost`(20=h)/
  `handoffSecondaryQuality`(0.9=q')/`handoffDefaultTaskValue`(50)。
- プライミング提案: 集中作業の前に 5h 窓の状態から待つべきかを命題2/§9 E2 で判定。
  アクティブな窓は ping で前倒しリセットできない（ping は現行窓を消費するだけ）ため、
  アクティブ×消費済み×deep 後リセットは `wait_for_reset`（リセットを待つか低予算を受け入れる）。
  期限切れ窓は次の発話が新窓を開く＝不要。`src/coach/priming.ts`（純関数＋IO アダプタ）、
  MCP tool `suggest_priming`、CLI `cogsync suggest-priming [--deep-duration N] [--json]`。提案のみ。
  config: `thresholds.primeIfUsedPct`(50)/`primeDefaultDeepDurationMin`(120)。

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
