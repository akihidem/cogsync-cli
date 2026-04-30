/**
 * handoff: llm
 *
 * Ollama 経由でセッションログから構造化ハンドオフを自動生成する。
 * デフォは無効、`cogsync handoff --llm` でオプトイン。
 *
 * 環境:
 *   - Ollama: http://localhost:11434 (WSL 側、memory project_system_context.md 参照)
 *   - モデル: gemma4:latest (8B Q4_K_M, VRAM 8GB に収まらず CPU/GPU 混合で遅め)
 *
 * セッション末尾 N 行 (user/assistant のテキスト) を抽出して Ollama に投げる。
 * JSON モード (`format: "json"`) で構造化出力を要求し、HandoffStruct にパース。
 */

import { readFileSync } from "node:fs";
import type { HandoffStruct } from "./template.ts";

const SYSTEM_PROMPT = `You are cogsync's session summarizer. The user has been working with Claude Code.
Compress the recent session into a Handoff JSON with these keys:
- goal (string, 1 line, what the user is trying to achieve)
- state (string, 2-4 lines, what was done so far in concrete terms)
- decisions (string[], confirmed decisions only)
- openQuestions (string[], unresolved questions)
- nextAction (string, 1 line, concrete next step)

Rules:
- Respond with ONLY valid JSON, no surrounding text or markdown.
- Do not include code blocks; reference file paths instead.
- Be concise (each string field at most 200 chars).
- If a field has no content, use "" or [].
- Output language: Japanese.`;

export type LlmHandoffOptions = {
  /** Ollama base URL (e.g. http://localhost:11434) */
  ollamaUrl?: string;
  /** モデル名 */
  model?: string;
  /** セッション末尾の何行を要約対象に含めるか */
  tailLines?: number;
  /** Ollama 呼び出しのタイムアウト ms */
  timeoutMs?: number;
};

const DEFAULTS = {
  ollamaUrl: "http://localhost:11434",
  model: "gemma4:latest",
  tailLines: 60,
  timeoutMs: 180_000,
};

export class LlmHandoffError extends Error {
  public override readonly cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "LlmHandoffError";
    this.cause = cause;
  }
}

/**
 * 指定 JSONL から末尾の user/assistant テキストを抽出して 1 つの prompt 文字列にする。
 */
export function buildPromptFromSession(jsonlPath: string, tailLines: number): string {
  const text = readFileSync(jsonlPath, "utf8");
  const lines = text.split("\n").filter((l) => l.length > 0);
  const tail = lines.slice(-Math.max(1, tailLines));
  const out: string[] = [];
  for (const line of tail) {
    let rec: Record<string, unknown>;
    try {
      rec = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const t = rec["type"];
    if (t === "user") {
      const content = (rec["content"] as string | undefined) ?? extractFromMessage(rec);
      if (content) out.push(`USER: ${truncate(content, 1000)}`);
    } else if (t === "assistant") {
      const content = extractFromMessage(rec);
      if (content) out.push(`ASSISTANT: ${truncate(content, 1000)}`);
    }
  }
  return out.join("\n\n");
}

function extractFromMessage(rec: Record<string, unknown>): string {
  const msg = rec["message"];
  if (!msg || typeof msg !== "object") return "";
  const m = msg as Record<string, unknown>;
  const c = m["content"];
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    return c
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && "text" in part && typeof (part as { text?: unknown }).text === "string") {
          return (part as { text: string }).text;
        }
        return "";
      })
      .filter((s) => s.length > 0)
      .join("\n");
  }
  return "";
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + "…";
}

/**
 * Ollama を呼び出してハンドオフ要約を取得する。
 */
export async function summarizeWithOllama(
  jsonlPath: string,
  opts: LlmHandoffOptions = {},
): Promise<HandoffStruct> {
  const { ollamaUrl, model, tailLines, timeoutMs } = { ...DEFAULTS, ...opts };
  const sessionPrompt = buildPromptFromSession(jsonlPath, tailLines);
  if (sessionPrompt.length === 0) {
    throw new LlmHandoffError("session has no usable user/assistant messages");
  }

  const fullPrompt = `${SYSTEM_PROMPT}\n\n--- SESSION ---\n${sessionPrompt}\n--- END SESSION ---\n\nReturn JSON now.`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(`${ollamaUrl}/api/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model,
        prompt: fullPrompt,
        stream: false,
        format: "json",
        options: { temperature: 0.2 },
      }),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    throw new LlmHandoffError(
      `failed to call Ollama at ${ollamaUrl}: ${err instanceof Error ? err.message : String(err)}`,
      err,
    );
  }
  clearTimeout(timer);
  if (!res.ok) {
    const body = await res.text();
    throw new LlmHandoffError(`Ollama returned ${res.status}: ${body.slice(0, 200)}`);
  }

  const data = (await res.json()) as { response?: string };
  const raw = data.response ?? "";
  if (raw.length === 0) {
    throw new LlmHandoffError("Ollama returned empty response");
  }
  return parseHandoffPayload(raw);
}

function parseHandoffPayload(s: string): HandoffStruct {
  // 余計な装飾やマークダウンが混入することがあるので最初の JSON 物体を抽出
  const start = s.indexOf("{");
  if (start < 0) throw new LlmHandoffError(`no JSON object in LLM output: ${s.slice(0, 200)}`);
  const json = s.slice(start);
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    throw new LlmHandoffError(
      `failed to parse LLM JSON: ${err instanceof Error ? err.message : String(err)}`,
      err,
    );
  }
  if (parsed === null || typeof parsed !== "object") {
    throw new LlmHandoffError("LLM output is not a JSON object");
  }
  const o = parsed as Record<string, unknown>;
  const goal = stringOr(o["goal"], "");
  const state = stringOr(o["state"], "");
  const nextAction = stringOr(o["nextAction"] ?? o["next_action"], "");
  const decisions = stringArray(o["decisions"]);
  const openQuestions = stringArray(o["openQuestions"] ?? o["open_questions"]);

  if (!goal && !state && !nextAction) {
    throw new LlmHandoffError("LLM output missing all of goal/state/nextAction");
  }
  return { goal, state, nextAction, decisions, openQuestions };
}

function stringOr(v: unknown, fallback: string): string {
  return typeof v === "string" ? v : fallback;
}
function stringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string");
}
