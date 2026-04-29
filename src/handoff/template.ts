/**
 * handoff: template
 * セッションサマリから 200-400 token のハンドオフ・プロンプトを生成。
 * テンプレ本体は cogsync (調査) product/coaching-prompts.md §2 を参照し、
 * このファイルでは差し込み変数の埋め込みのみを担当する。
 *
 * MVP: 構造化テンプレ + ユーザー入力で生成（LLM なし）
 * v0.2: 軽量 LLM（Ollama or Haiku）でセッションログから自動要約
 */

export type HandoffStruct = {
  goal: string;
  state: string;
  decisions: string[];
  openQuestions: string[];
  nextAction: string;
};

export type HandoffOutput = {
  text: string; // クリップボードに貼る形（標準テンプレ）
  structured: HandoffStruct;
};

export function renderStandard(_struct: HandoffStruct, _title?: string): HandoffOutput {
  // TODO v0.2: テンプレ文字列に変数を差し込む
  throw new Error("renderStandard not implemented (v0.2)");
}

export function renderCrossModel(
  _struct: HandoffStruct,
  _fromModel: string,
  _toModel: string,
  _fromTokenCount: number,
): HandoffOutput {
  // TODO v0.2
  throw new Error("renderCrossModel not implemented (v0.2)");
}
