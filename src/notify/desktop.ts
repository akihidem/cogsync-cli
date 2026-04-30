/**
 * notify: desktop
 *
 * node-notifier ラッパ。テンプレ ID + 変数 で通知を発行する。
 * 文言の元は cogsync 本体 (調査) product/coaching-prompts.md §1。
 *
 * MVP は文言を本ファイル内で短くインライン定義し、テンプレ ID で参照する。
 * 将来は YAML 外部化を検討。
 *
 * 失敗時（WSL で libnotify が無い等）は console.log にフォールバックする。
 */

import notifier from "node-notifier";

export type NotifySeverity = "info" | "nudge" | "warn" | "critical";
export type NotifyTone = "neutral" | "librarian" | "coach" | "kansai";

export type NotifyRequest = {
  template: string;
  severity: NotifySeverity;
  vars: Record<string, string | number>;
  tone?: NotifyTone;
};

type Rendered = {
  title: string;
  body: string;
};

/**
 * 通知テンプレ。ニュートラルトーンのみ実装（v0.1）。
 * 残りトーン (librarian/coach/kansai) は v0.3 で追加。
 */
const TEMPLATES: Record<string, (vars: Record<string, string | number>) => Rendered> = {
  limit_approaching: (v) => ({
    title: "cogsync — リミット接近",
    body:
      `Claude 5h ウィンドウ残り推定 ${v["remaining_min"]} 分。\n` +
      `このペースだと作業中にウィンドウが切れます。セッションを切ってハンドオフ・プロンプトを生成することを推奨。`,
  }),
  burn_exhaustion: (v) => ({
    title: "cogsync — 枯渇予測",
    body:
      `現バーンレート想定だと ${v["minutes_to_exhaustion"]} 分でリミット枯渇。\n` +
      `ウィンドウ終了時刻 (${v["window_end_hhmm"]}) より早く尽きます。`,
  }),
  watch_started: (v) => ({
    title: "cogsync watch 開始",
    body: `${v["polling_sec"]} 秒間隔でリミットを観測中。閾値: 残 ${v["limit_warn_min"]} 分で警告。`,
  }),
  snowball_detected: (v) => ({
    title: "cogsync — 雪だるま検出",
    body:
      `現セッションのコンテキストが ${v["cumulative_kt"]}k token に到達（閾値 ${v["threshold_kt"]}k）。\n` +
      `Lost-in-the-middle のリスク。新規セッションへ切り出しを推奨。`,
  }),
  deepwork_cap_reached: (v) => ({
    title: "cogsync — ディープワーク上限",
    body:
      `今日の集中時間が ${v["accumulated_min"]} 分（上限 ${v["daily_cap_min"]} 分）に到達。\n` +
      `これ以降は精度が落ちやすい。シャローワークか終了を推奨。`,
  }),
};

export interface DesktopNotifier {
  notify(req: NotifyRequest): Promise<void>;
  setQuiet(quiet: boolean): void;
}

export function createDesktopNotifier(_defaultTone: NotifyTone = "neutral"): DesktopNotifier {
  let quiet = false;

  return {
    setQuiet(q: boolean) {
      quiet = q;
    },
    async notify(req: NotifyRequest): Promise<void> {
      if (quiet) return;
      const tmpl = TEMPLATES[req.template];
      if (!tmpl) {
        console.error(`[cogsync] unknown template: ${req.template}`);
        return;
      }
      const rendered = tmpl(req.vars);
      const tag = severityTag(req.severity);
      try {
        await new Promise<void>((resolve) => {
          notifier.notify(
            {
              title: rendered.title,
              message: rendered.body,
              wait: false,
            },
            (err) => {
              if (err) {
                // libnotify 不在等。console にフォールバック
                console.log(`${tag} ${rendered.title}\n  ${rendered.body.replace(/\n/g, "\n  ")}`);
              }
              resolve();
            },
          );
        });
      } catch {
        console.log(`${tag} ${rendered.title}\n  ${rendered.body.replace(/\n/g, "\n  ")}`);
      }
    },
  };
}

function severityTag(s: NotifySeverity): string {
  switch (s) {
    case "info":
      return "[info]";
    case "nudge":
      return "[nudge]";
    case "warn":
      return "[warn]";
    case "critical":
      return "[!!]";
  }
}
