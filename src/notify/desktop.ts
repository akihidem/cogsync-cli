/**
 * notify: desktop
 *
 * 通知の配送順:
 *   1. WSL 検出時 → powershell.exe で Windows トースト
 *   2. node-notifier (libnotify / macOS / Windows ネイティブ)
 *   3. console.log フォールバック
 *
 * テンプレ ID + 変数で文言生成。文言の元は cogsync 本体
 * product/coaching-prompts.md §1。
 */

import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
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
  deep_break_suggested: (v) => ({
    title: "cogsync — ブレイク推奨",
    body:
      `AI 処理待ちが ${v["ai_busy_min"]} 分続いています。\n` +
      `${v["suggested_break_min"]} 分のディープ・ブレイクを推奨。今 PC から離れるのが最適です。`,
  }),
  pomodoro_focus_started: (v) => ({
    title: `pomodoro #${v["cycle"]} — focus`,
    body:
      v["focus_min"] === 0
        ? `AI 処理待ちが長いため早期ブレイクへ移行します。`
        : `集中 ${v["focus_min"]} 分開始。終了予定 ${v["ends_hhmm"]}。`,
  }),
  pomodoro_break_started: (v) => ({
    title: `pomodoro #${v["cycle"]} — break`,
    body: `休憩 ${v["break_min"]} 分。再開予定 ${v["ends_hhmm"]}。席を立つことを推奨。`,
  }),
  pomodoro_break_ended: (v) => ({
    title: `pomodoro #${v["cycle"]} — back to focus`,
    body: `休憩終了。次の集中フェーズへ。`,
  }),
};

export interface DesktopNotifier {
  notify(req: NotifyRequest): Promise<void>;
  setQuiet(quiet: boolean): void;
}

export function createDesktopNotifier(_defaultTone: NotifyTone = "neutral"): DesktopNotifier {
  let quiet = false;
  const wsl = isWsl();

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
      const consoleFallback = () =>
        console.log(`${tag} ${rendered.title}\n  ${rendered.body.replace(/\n/g, "\n  ")}`);

      // 1. WSL → powershell.exe toast
      if (wsl) {
        const ok = await notifyViaPowerShell(rendered.title, rendered.body);
        if (ok) return;
        // fallthrough to node-notifier
      }

      // 2. node-notifier
      const ok = await notifyViaNodeNotifier(rendered);
      if (ok) return;

      // 3. console
      consoleFallback();
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

function isWsl(): boolean {
  try {
    const v = readFileSync("/proc/version", "utf8");
    return /microsoft/i.test(v);
  } catch {
    return false;
  }
}

function notifyViaNodeNotifier(rendered: Rendered): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      notifier.notify(
        { title: rendered.title, message: rendered.body, wait: false },
        (err) => resolve(!err),
      );
    } catch {
      resolve(false);
    }
  });
}

function escapeXmlText(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/'/g, "&apos;")
    .replace(/"/g, "&quot;");
}

/** PowerShell シングルクォート文字列 (`'...'`) のエスケープ。`'` を `''` に */
function escapePsSingle(s: string): string {
  return s.replace(/'/g, "''");
}

function notifyViaPowerShell(title: string, body: string): Promise<boolean> {
  // \n は &#10; (XML char ref) に変換してトースト本文の改行に
  const xmlBody = escapeXmlText(body).replace(/\n/g, "&#10;");
  const xmlTitle = escapeXmlText(title);
  const xml = `<toast><visual><binding template='ToastGeneric'><text>${xmlTitle}</text><text>${xmlBody}</text></binding></visual></toast>`;
  const xmlForPs = escapePsSingle(xml);

  const ps =
    `[Windows.UI.Notifications.ToastNotificationManager,Windows.UI.Notifications,ContentType=WindowsRuntime]|Out-Null;` +
    `[Windows.Data.Xml.Dom.XmlDocument,Windows.Data.Xml.Dom,ContentType=WindowsRuntime]|Out-Null;` +
    `$x=New-Object Windows.Data.Xml.Dom.XmlDocument;` +
    `$x.LoadXml('${xmlForPs}');` +
    `$t=[Windows.UI.Notifications.ToastNotification]::new($x);` +
    `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('cogsync').Show($t)`;

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], {
        stdio: ["ignore", "ignore", "pipe"],
      });
    } catch {
      resolve(false);
      return;
    }
    let stderr = "";
    child.stderr?.on("data", (c: Buffer) => {
      stderr += c.toString("utf8");
    });
    child.on("error", () => resolve(false));
    child.on("close", (code) => {
      if (code !== 0 && stderr.length > 0) {
        console.error(`[cogsync] powershell toast failed (${code}): ${stderr.trim().slice(0, 200)}`);
      }
      resolve(code === 0);
    });
  });
}
