# cogsync MCP サーバ (v0.5)

cogsync の現在の作業状態を Model Context Protocol で公開する読み取り専用サーバ。
Claude Code 等の MCP クライアントから「いまフェーズなに？ / 5h ウィンドウどれくらい残ってる？」を
問い合わせて、人間への介入頻度を下げるのが目的。

仕様の詳細: `cogsync` 本体（調査リポ）の `product/mcp-server-spec.md` を参照。

## 現在実装されているもの (v0.5.0-alpha.0)

| URI | 内容 |
| --- | --- |
| `cogsync://state/phase` | 現在のフェーズ (`design`/`implement`/`review`/`break`) + stale 判定 + 推奨モデル |
| `cogsync://state/limits` | ccusage の active 5h ブロックから残時間・累計トークン・バーンレート |
| `cogsync://state/deepwork` | 今日のディープワーク累積分 + 履歴 (watch コマンド経由で永続化されたもの) |
| `cogsync://state/active-session` | 真にアクティブな Claude Code セッションのメタ |

Tools (set_phase / create_handoff 等) と Prompts (handoff/standard 等) は v1.0 で実装予定。
v0.5 は **副作用なし**、読み取り専用。

## 起動

stdio transport のみ（spec §6.1: ローカル限定）。

```bash
# 動作確認用に手動起動
cd ~/Projects/cogsync-cli
npx tsx src/index.ts mcp

# または npm スクリプト経由（package.json に "mcp": "tsx src/index.ts mcp" を足してもよい）
```

stdin に JSON-RPC を流すと stdout に応答が返る。普段は MCP クライアント（Claude Code 等）が
stdio 経由で起動するので、人間が直接叩く必要はない。

## Claude Code への登録

`~/.config/claude/mcp.json`（or プロジェクト直下の `.mcp.json`）に追加:

```json
{
  "mcpServers": {
    "cogsync": {
      "command": "npx",
      "args": ["tsx", "/home/muko1/Projects/cogsync-cli/src/index.ts", "mcp"]
    }
  }
}
```

登録後、Claude Code を再起動するとリソースが見えるようになる。
読み取りは Claude Code の resource 自動取得 or `/mcp` メニューから手動。

## 動作確認 (手動 JSON-RPC)

```bash
cd ~/Projects/cogsync-cli
(
  echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"0.0.1"}}}'
  echo '{"jsonrpc":"2.0","method":"notifications/initialized"}'
  echo '{"jsonrpc":"2.0","id":2,"method":"resources/list"}'
  echo '{"jsonrpc":"2.0","id":3,"method":"resources/read","params":{"uri":"cogsync://state/phase"}}'
  sleep 2
) | npx tsx src/index.ts mcp
```

## 設計メモ

- Resources の handler は `src/mcp/resources.ts` に pure 関数として切り出してある。
  ファイルシステムや subprocess に依存しない関数（`buildPhaseState` / `buildDeepWorkState`）は
  `tests/mcp-resources.test.ts` で単体テスト済み。
- `state/limits` は cogsync 本体と同じく `fetchActiveBlockCached` を使う。TTL は config の
  `observers.ccusage.pollingSec * 0.9` 秒。MCP クライアントが連続で叩いても ccusage の
  起動コストは TTL 内で 1 回に抑えられる。
- `state/active-session` は v0.4 で導入した `findActiveSession` をそのまま使う。
  「直近 N 分以内に user/assistant イベント」を満たすセッションのみが top に上がる。
- 副作用なしを徹底するため、Tools と Prompts は別バージョン (v1.0) でまとめて実装する。
  Spec §6.2 の「書き込み系ツールはユーザー確認必須」も合わせて入れる。

## v1.0 への TODO

- Tools: `set_phase` / `create_handoff` / `start_timer` / `report_token_usage` 等（書き込み系は
  サーバ側で確認プロンプトを挿入）
- Prompts: `handoff/standard` / `coach/phase-design-start` 等
- 履歴 Resources: `cogsync://history/handoffs?since=...` 等（履歴永続化も同時に必要）
- セキュリティ: ログ由来テキストを LLM に渡す場合のサニタイザ
