/**
 * MCP prompts: cogsync が AI に提供するプロンプト・テンプレ。
 *
 * v1.0 で提供する 4 Prompt:
 *   - handoff/standard         標準ハンドオフ
 *   - handoff/cross-model      モデル間引継ぎ
 *   - coach/phase-design-start 設計フェーズ開始時の自己問いかけ
 *   - coach/before-take-break  ブレイク前サマリ作成テンプレ
 *
 * spec: cogsync 本体 product/mcp-server-spec.md §5
 * 文言: cogsync 本体 product/coaching-prompts.md §1.2, §1.4, §2
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { renderStandard, renderCrossModel } from "../handoff/template.ts";

export function registerPrompts(server: McpServer): void {
  // ─── handoff/standard ────────────────────────────────────────────────────────
  server.registerPrompt(
    "handoff/standard",
    {
      title: "標準ハンドオフ",
      description:
        "セッション間のコンテキスト引継ぎ用テンプレ。goal / state / nextAction を埋めて使う。",
      argsSchema: {
        goal: z.string().describe("達成目標"),
        state: z.string().describe("現在の進捗状況"),
        nextAction: z.string().describe("次のアクション"),
        decisions: z.string().optional().describe("確定した判断事項（カンマ区切り）"),
        openQuestions: z.string().optional().describe("未解決の問い（カンマ区切り）"),
      },
    },
    (args) => {
      const struct = {
        goal: args.goal,
        state: args.state,
        nextAction: args.nextAction,
        decisions: args.decisions ? args.decisions.split(",").map((s) => s.trim()) : [],
        openQuestions: args.openQuestions ? args.openQuestions.split(",").map((s) => s.trim()) : [],
      };
      const output = renderStandard(struct);
      return {
        messages: [
          {
            role: "user" as const,
            content: { type: "text" as const, text: output.text },
          },
        ],
      };
    },
  );

  // ─── handoff/cross-model ─────────────────────────────────────────────────────
  server.registerPrompt(
    "handoff/cross-model",
    {
      title: "モデル間引継ぎ",
      description:
        "異なるモデル間でのコンテキスト引継ぎ用。前モデル名・トークン数を明示して要約を渡す。",
      argsSchema: {
        goal: z.string().describe("達成目標"),
        state: z.string().describe("現在の進捗の要約"),
        nextAction: z.string().describe("次のアクション"),
        decisions: z.string().optional().describe("確定した判断事項（カンマ区切り）"),
        fromModel: z.string().describe("引継ぎ元モデル名（例: claude-opus-4-6）"),
        toModel: z.string().describe("引継ぎ先モデル名（例: claude-sonnet-4-6）"),
        fromTokenCount: z.string().describe("引継ぎ元のコンテキストトークン数"),
      },
    },
    (args) => {
      const struct = {
        goal: args.goal,
        state: args.state,
        nextAction: args.nextAction,
        decisions: args.decisions ? args.decisions.split(",").map((s) => s.trim()) : [],
        openQuestions: [],
      };
      const output = renderCrossModel(
        struct,
        args.fromModel,
        args.toModel,
        parseInt(args.fromTokenCount, 10) || 0,
      );
      return {
        messages: [
          {
            role: "user" as const,
            content: { type: "text" as const, text: output.text },
          },
        ],
      };
    },
  );

  // ─── coach/phase-design-start ────────────────────────────────────────────────
  server.registerPrompt(
    "coach/phase-design-start",
    {
      title: "設計フェーズ開始ガイド",
      description:
        "設計フェーズに移行した際の自己問いかけテンプレ。要件整理・アーキテクチャ検討の起点。",
    },
    () => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: [
              "# 設計フェーズ開始",
              "",
              "設計フェーズに移行しました。",
              "推奨：ブラウザの Claude Opus、または Claude Code Opus を 1 対 1 で使う。",
              "",
              "以下を整理してから実装に移ってください：",
              "",
              "1. **解決すべき問題は何か？** — 背景と制約を明文化",
              "2. **どんなアプローチがあるか？** — 最低 2 案を比較",
              "3. **採用案の判断根拠は？** — トレードオフを言語化",
              "4. **スコープの境界は？** — 今回やること／やらないこと",
              "5. **検証方法は？** — 完了をどう確認するか",
              "",
              "完了したらハンドオフ・プロンプトを作成し、実装フェーズに移行します。",
            ].join("\n"),
          },
        },
      ],
    }),
  );

  // ─── coach/before-take-break ─────────────────────────────────────────────────
  server.registerPrompt(
    "coach/before-take-break",
    {
      title: "ブレイク前サマリ",
      description:
        "席を立つ前にいまの状態を書き出すためのテンプレ。戻ってきたときに迷わないための記録。",
    },
    () => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: [
              "# ブレイク前チェックリスト",
              "",
              "席を立つ前に以下を書き出してください：",
              "",
              "1. **いま何をしていたか** — 作業内容を 1-2 行で",
              "2. **どこまで終わったか** — 完了済みステップ",
              "3. **次に何をするか** — 戻ってきたら最初にやること",
              "4. **未保存の変更はあるか** — コミット忘れ・編集中ファイル",
              "5. **動いているプロセスはあるか** — watch / build / test 等",
              "",
              "これをハンドオフとして保存しておくと、中断からの復帰がスムーズです。",
            ].join("\n"),
          },
        },
      ],
    }),
  );
}
