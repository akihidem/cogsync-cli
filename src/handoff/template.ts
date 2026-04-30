/**
 * handoff: template
 *
 * セッション間のコンテキスト引継ぎ用テンプレ。
 * テンプレ本体は cogsync 本体 (調査) product/coaching-prompts.md §2 に準拠。
 *
 * v0.1: 構造化入力からテキストを生成するだけ（LLM 不使用）
 * v0.2: ccusage / claude_code 観測ログから自動要約
 */

export type HandoffStruct = {
  goal: string;
  state: string;
  decisions: string[];
  openQuestions: string[];
  nextAction: string;
};

export type HandoffOutput = {
  text: string;
  structured: HandoffStruct;
};

export function renderStandard(struct: HandoffStruct, title?: string): HandoffOutput {
  const header = title ? `# Handoff: ${title}` : `# Handoff`;
  const decisions = bulletList(struct.decisions);
  const questions = bulletList(struct.openQuestions);
  const ts = new Date().toISOString();

  const text =
    `${header}\n\n` +
    `- Goal: ${struct.goal}\n` +
    `- State: ${struct.state}\n` +
    `- Decisions:\n${decisions}\n` +
    `- Open Questions:\n${questions}\n` +
    `- Next Action: ${struct.nextAction}\n\n` +
    `[Created by cogsync at ${ts}]\n`;

  return { text, structured: struct };
}

export function renderCrossModel(
  struct: HandoffStruct,
  fromModel: string,
  toModel: string,
  fromTokenCount: number,
): HandoffOutput {
  const decisions = bulletList(struct.decisions);
  const text =
    `# Handoff (Cross-Model: ${fromModel} → ${toModel})\n\n` +
    `前モデル (${fromModel}) では ${fromTokenCount.toLocaleString()} token のコンテキストで作業していました。\n` +
    `このセッションでは要約のみを引き継ぎます。\n\n` +
    `- Goal: ${struct.goal}\n` +
    `- Recap (要約): ${struct.state}\n` +
    `- Confirmed Decisions:\n${decisions}\n` +
    `- Next Action: ${struct.nextAction}\n`;

  return { text, structured: struct };
}

function bulletList(items: string[]): string {
  if (items.length === 0) return "  (none)";
  return items.map((s) => `  - ${s}`).join("\n");
}

/**
 * JSON 文字列からハンドオフ構造体をパース。
 * 必須フィールド欠損で throw、配列フィールドの欠損は空配列に補完。
 */
export function parseHandoffJson(s: string): HandoffStruct {
  const raw = JSON.parse(s) as unknown;
  if (raw === null || typeof raw !== "object") {
    throw new Error("handoff JSON must be an object");
  }
  const o = raw as Record<string, unknown>;
  if (typeof o["goal"] !== "string") throw new Error("handoff.goal (string) required");
  if (typeof o["state"] !== "string") throw new Error("handoff.state (string) required");
  if (typeof o["nextAction"] !== "string") throw new Error("handoff.nextAction (string) required");

  return {
    goal: o["goal"],
    state: o["state"],
    nextAction: o["nextAction"],
    decisions: toStringArray(o["decisions"]),
    openQuestions: toStringArray(o["openQuestions"]),
  };
}

function toStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string");
}
