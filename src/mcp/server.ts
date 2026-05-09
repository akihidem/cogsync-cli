/**
 * MCP server: cogsync の状態を読み取り専用 Resources として公開する。
 *
 * stdio transport で起動。Claude Code 等の MCP クライアントは
 * `~/.config/claude/mcp.json` (or `.mcp.json`) で `command: "npx", args: ["tsx", "..."]`
 * のように登録する。
 *
 * spec §6.1 のとおり「ローカル限定 / リモート公開しない」を満たすため、stdio 限定。
 * Tools/Prompts は v1.1 以降。本実装は Resources のみ（読み取り専用、副作用なし）。
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "../config.ts";
import { JsonStore } from "../state/store.ts";
import {
  readActiveSessionResource,
  readDeepWorkResource,
  readLimitsResource,
  readPhaseResource,
  type ResourceContext,
} from "./resources.ts";

const PKG_NAME = "cogsync-cli";
const PKG_VERSION = "0.5.0-alpha.0";

export async function runMcpServer(): Promise<void> {
  const { config } = loadConfig();
  const store = new JsonStore();
  const ctx: ResourceContext = { config, store };

  const server = new McpServer(
    { name: PKG_NAME, version: PKG_VERSION },
    {
      capabilities: { resources: {} },
      instructions:
        "cogsync の現在の作業状態（フェーズ・5h リミット・ディープワーク累積・アクティブセッション）を読み取り専用で公開する MCP サーバ。タスク開始前や手詰まり時に状態を問い合わせて、人間への介入頻度を下げる用途を想定。",
    },
  );

  server.registerResource(
    "phase",
    "cogsync://state/phase",
    {
      title: "現在のフェーズ",
      description:
        "design / implement / review / break のいずれか。stale=true なら最後の set から phaseStaleHours を超過していて参考にすべきでない。",
      mimeType: "application/json",
    },
    (uri) => jsonResource(uri, readPhaseResource(ctx)),
  );

  server.registerResource(
    "limits",
    "cogsync://state/limits",
    {
      title: "AI ツールのリミット残量",
      description:
        "ccusage の active 5h ブロックから現在の残時間・累計トークン・バーンレートを返す。ブロックなしなら window5h: null。",
      mimeType: "application/json",
    },
    async (uri) => jsonResource(uri, await readLimitsResource(ctx)),
  );

  server.registerResource(
    "deepwork",
    "cogsync://state/deepwork",
    {
      title: "今日のディープワーク累積",
      description:
        "watch コマンド経由で永続化された deepWork.byDate から今日の合計分と履歴を返す。watch を起動していない期間はカウントされない。",
      mimeType: "application/json",
    },
    (uri) => jsonResource(uri, readDeepWorkResource(ctx)),
  );

  server.registerResource(
    "active-session",
    "cogsync://state/active-session",
    {
      title: "真にアクティブな Claude Code セッション",
      description:
        "最新の user/assistant イベントが activeSessionWindowMin 分以内のセッションを 1 件返す。条件を満たすセッションが無ければ null。",
      mimeType: "application/json",
    },
    (uri) => jsonResource(uri, readActiveSessionResource(ctx)),
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdio transport は process.stdin の close で自動的に切断される
}

function jsonResource(uri: URL, data: unknown) {
  return {
    contents: [
      {
        uri: uri.href,
        mimeType: "application/json",
        text: JSON.stringify(data, null, 2),
      },
    ],
  };
}
