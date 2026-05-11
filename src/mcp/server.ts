/**
 * MCP server: cogsync の状態を Resources / Tools / Prompts として公開する。
 *
 * stdio transport で起動。Claude Code 等の MCP クライアントは
 * `~/.config/claude/mcp.json` (or `.mcp.json`) で `command: "npx", args: ["tsx", "..."]`
 * のように登録する。
 *
 * spec §6.1 のとおり「ローカル限定 / リモート公開しない」を満たすため、stdio 限定。
 *
 * v0.5: Resources のみ（読み取り専用）
 * v1.0: Tools（set_phase, get_recommended_action, create_handoff）+ Prompts 4 種を追加
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
import { registerTools } from "./tools.ts";
import { registerPrompts } from "./prompts.ts";

const PKG_NAME = "cogsync-cli";
const PKG_VERSION = "1.0.0-alpha.1";

/**
 * stderr 経由で起動ログを出す。Claude Code 等のクライアントは
 * stdout を JSON-RPC に予約しているので、診断用ログは必ず stderr 側に流す。
 * MCP クライアントの mcp-logs にはこの行は載らないが、`cogsync mcp 2>cogsync.log`
 * のような手動診断時や、Claude Code が今後 stderr 取り込みに対応した時に役立つ。
 */
function logStartup(stage: string, extra: Record<string, unknown> = {}): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), stage, ...extra });
  process.stderr.write(line + "\n");
}

export async function runMcpServer(): Promise<void> {
  logStartup("boot", { pid: process.pid, ppid: process.ppid, node: process.version });
  const { config } = loadConfig();
  logStartup("config-loaded");
  const store = new JsonStore();
  const ctx: ResourceContext = { config, store };

  const server = new McpServer(
    { name: PKG_NAME, version: PKG_VERSION },
    {
      capabilities: { resources: {}, tools: {}, prompts: {} },
      instructions:
        "cogsync の作業状態（フェーズ・5h リミット・ディープワーク累積・アクティブセッション）の読み取りと、フェーズ切替・推奨アクション取得・ハンドオフ生成を提供する MCP サーバ。タスク開始前や手詰まり時に状態を問い合わせ、セッション内でフェーズを切り替えることで人間への介入頻度を下げる。",
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
        "watch コマンド経由で永続化された deepWork.byDate から今日の合計分と履歴を返す。permissionMode 別に manual/auto/bypass バケットの内訳も同梱。watch を起動していない期間はカウントされない。",
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

  registerTools(server, ctx);
  registerPrompts(server);
  logStartup("handlers-registered");

  // 親プロセスが SIGTERM/SIGINT で落とした場合、確実に exit する。
  // 既定では node はシグナルで死ぬが、明示しておく方が再接続時の race を減らせる。
  // （観測: npm link 直後の MCP 再接続で旧プロセス exit と新プロセス spawn が
  //  重なると、まれに新プロセスの initialize 応答が 30s タイムアウトする事象あり。）
  const onSignal = (sig: NodeJS.Signals) => {
    logStartup("signal", { sig });
    process.exit(0);
  };
  process.once("SIGTERM", onSignal);
  process.once("SIGINT", onSignal);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  logStartup("connected");
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
