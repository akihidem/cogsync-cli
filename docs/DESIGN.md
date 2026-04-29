# cogsync-cli — 内部設計

## 1. レイヤー構造

```
┌─────────────────────────────────────────────────┐
│  CLI (src/index.ts)                             │
│  - watch / status / handoff / phase / pomodoro  │
└────────────┬────────────────────────────────────┘
             │
   ┌─────────┴──────────┬──────────┬──────────┐
   ▼                    ▼          ▼          ▼
┌──────────┐    ┌──────────────┐  ┌───────┐  ┌────────┐
│Observers │    │   Inference  │  │Coach  │  │Timer   │
│(OB-*)    │───▶│   (IN-*)     │─▶│(CO-*) │──│(TI-*)  │
└──────────┘    └──────────────┘  └───┬───┘  └────────┘
                                      │
                              ┌───────┴───────┐
                              ▼               ▼
                        ┌──────────┐    ┌──────────┐
                        │ Notify   │    │ Handoff  │
                        │ (Desktop)│    │ (HO-*)   │
                        └──────────┘    └──────────┘
                              │
                              ▼
                        ┌──────────┐
                        │ State    │
                        │ (SQLite) │
                        └──────────┘
```

## 2. 各層の責務

### 2.1 Observers — 観測

外部入力を統一的なイベントに正規化する。

| ファイル | 責務 |
| --- | --- |
| `observers/ccusage.ts` | ccusage の MCP 統合 or JSONL を直接読み、`UsageEvent` を発行 |
| `observers/claude_code.ts` | `~/.claude/projects/**/*.jsonl` を chokidar で監視し、新セッションを検知 |

イベント例：

```ts
type UsageEvent = {
  kind: "usage";
  tool: "claude_code";
  session_id: string;
  timestamp: Date;
  tokens: { input: number; output: number; cache_read: number; cache_create: number };
  model: string;
};
```

### 2.2 Inference — 推論

観測イベントから派生量を計算する。純粋関数。

| ファイル | 責務 |
| --- | --- |
| `infer/window5h.ts` | 5h ローリングウィンドウの開始・終了・残量・推定枯渇時刻 |
| `infer/snowball.ts` | セッション内累積トークンが閾値を超えたかの判定 |
| `infer/deepwork.ts` | 当日のディープワーク累積分数（アクティブ入力ベース or 手動セッション境界） |

### 2.3 Coach — 指南

推論結果から「いま何をすべきか」を判断する。

| ファイル | 責務 |
| --- | --- |
| `coach/phase.ts` | 現フェーズの管理（MVP は手動切替） |
| `coach/advise.ts` | フェーズ・残量・スキルプロファイルから推奨アクションを 1 つ選ぶ |

`advise()` の出力は `coaching-prompts.md` のテンプレと結合して通知本文になる。

### 2.4 Timer — タイマー

| ファイル | 責務 |
| --- | --- |
| `timer/adaptive.ts` | ポモドーロ／ディープ・ブレイク／AI 待機の各タイマー。AI 処理イベントで動的伸縮 |

### 2.5 Handoff — ハンドオフ生成

| ファイル | 責務 |
| --- | --- |
| `handoff/template.ts` | セッションサマリから 200-400 token のハンドオフ・プロンプトを生成 |

MVP では LLM を使わず、構造化テンプレ + ユーザー入力で生成。v0.2 以降に軽量 LLM（Ollama or Haiku）を統合。

### 2.6 Notify — 通知

| ファイル | 責務 |
| --- | --- |
| `notify/desktop.ts` | `node-notifier` ラッパ。トーン別／重要度別の通知を発行 |

通知は `coaching-prompts.md` のテンプレ ID で発行する：

```ts
notify({ template: "limit_approaching", vars: { remaining_min: 15, alt_model: "Sonnet" } });
```

### 2.7 State — 永続化

| ファイル | 責務 |
| --- | --- |
| `state/store.ts` | better-sqlite3 でローカル DB を管理。スキーマは `requirements.md` のデータモデルに準拠 |

スキーマ初期版：

```sql
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  tool TEXT,
  phase TEXT,
  started_at INTEGER,
  ended_at INTEGER,
  project_id TEXT,
  parent_session_id TEXT
);

CREATE TABLE token_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT,
  ts INTEGER,
  input INTEGER, output INTEGER,
  cache_read INTEGER, cache_create INTEGER,
  model TEXT,
  FOREIGN KEY (session_id) REFERENCES sessions(id)
);

CREATE TABLE handoffs (
  id TEXT PRIMARY KEY,
  created_at INTEGER,
  from_session_id TEXT,
  to_session_id TEXT,
  text TEXT,
  structured TEXT  -- JSON
);

CREATE TABLE deep_work_spans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT,           -- YYYY-MM-DD
  total_focused_min INTEGER
);
```

## 3. データフロー（典型例：リミット接近警告）

```
1. observers/ccusage.ts が 30 秒ごとに ccusage 5h block を取得
2. infer/window5h.ts が消費速度から枯渇時刻を予測
3. coach/advise.ts が「残 15 分以内 + 現フェーズが implement」を検知
4. coach/advise.ts が「ハンドオフして切る」を推奨
5. handoff/template.ts でハンドオフ・プロンプト生成
6. notify/desktop.ts で `limit_approaching` テンプレに変数を埋めて通知
7. state/store.ts に通知履歴を記録（スヌーズ／実行のフィードバックを後で集計）
```

## 4. 設定ファイル（暫定）

`~/.config/cogsync/config.yaml`

```yaml
profile:
  parallel_capacity: 3       # 並列許容度（1-10+）
  daily_deep_work_cap_min: 240
  hourly_rate_yen: 5000      # 集中時間の機会コスト計算用

observers:
  ccusage:
    enabled: true
    polling_sec: 30
  claude_code:
    enabled: true
    log_dir: ~/.claude/projects

thresholds:
  snowball_token: 80000      # セッション内累積でこれを超えたら通知
  limit_warn_min: 15         # 残何分で警告するか

notify:
  tone: neutral              # neutral | librarian | coach | kansai
  quiet_during_ai_work: true # AI 処理中は通知抑制
```

## 5. テスト戦略

- **Inference 層は純粋関数**：単体テストで網羅
- **Observers は契約テスト**：ccusage が返す JSON を fixture 化
- **Notify はモック**：実際の OS 通知は手動確認

## 6. 次のステップ

- [ ] CLI エントリ（`src/index.ts`）の commander コマンド定義
- [ ] `observers/ccusage.ts` で実際の ccusage MCP 連携を試す
- [ ] `infer/window5h.ts` のロジックを過去 30 日のログでバックテスト
- [ ] `notify/desktop.ts` で macOS / Linux 両環境の動作確認
- [ ] 最初の機能：`bun run src/index.ts status` がリミット残量を 1 行出すまで
