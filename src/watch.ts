/**
 * watch: 常駐ループ
 *
 * setInterval で fetchActiveBlock をポーリング、WindowStatus を計算し、
 * 閾値超えで通知発火。同じウィンドウ内では同種の通知を 1 回しか出さない。
 *
 * SIGINT / SIGTERM でグレースフル終了。
 */

import { fetchActiveBlock, CcusageError } from "./observers/ccusage.ts";
import { computeWindowStatus, formatStatusLine, type WindowStatus } from "./infer/window5h.ts";
import { createDesktopNotifier } from "./notify/desktop.ts";
import type { CogsyncConfig } from "./config.ts";

type FiredKey = `${string}:${string}`; // `${blockId}:${templateId}`

export type WatchOptions = {
  config: CogsyncConfig;
  /** ループ間隔オーバーライド（テスト用） */
  pollingSecOverride?: number;
  /** 1 度だけ実行して終わる（テスト用） */
  once?: boolean;
};

export async function runWatch(opts: WatchOptions): Promise<void> {
  const { config } = opts;
  const pollingSec = opts.pollingSecOverride ?? config.observers.ccusage.pollingSec;
  const limitWarnMin = config.thresholds.limitWarnMin;
  const notifier = createDesktopNotifier(config.notify.tone);
  const fired = new Set<FiredKey>();

  await notifier.notify({
    template: "watch_started",
    severity: "info",
    vars: { polling_sec: pollingSec, limit_warn_min: limitWarnMin },
  });

  let stopped = false;
  const stop = (sig: NodeJS.Signals) => {
    if (stopped) return;
    stopped = true;
    console.log(`\n[cogsync] received ${sig}, stopping watch.`);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  // 起動直後 1 回 + その後 polling
  await tick({ notifier, fired, limitWarnMin });
  if (opts.once) return;

  while (!stopped) {
    await sleep(pollingSec * 1000, () => stopped);
    if (stopped) break;
    try {
      await tick({ notifier, fired, limitWarnMin });
    } catch (err) {
      // 1 回のエラーで死なせない
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[cogsync] tick error: ${msg}`);
    }
  }
}

type TickArgs = {
  notifier: ReturnType<typeof createDesktopNotifier>;
  fired: Set<FiredKey>;
  limitWarnMin: number;
};

async function tick({ notifier, fired, limitWarnMin }: TickArgs): Promise<void> {
  let block;
  try {
    block = await fetchActiveBlock();
  } catch (err) {
    if (err instanceof CcusageError) {
      console.error(`[cogsync] ${err.message}`);
      return;
    }
    throw err;
  }

  if (!block) {
    console.log(`[${nowHHMMSS()}] no active block`);
    return;
  }

  const status = computeWindowStatus(block);
  console.log(`[${nowHHMMSS()}] ${formatStatusLine(status)}`);

  await maybeFire(notifier, fired, block.id, status, limitWarnMin);
}

async function maybeFire(
  notifier: ReturnType<typeof createDesktopNotifier>,
  fired: Set<FiredKey>,
  blockId: string,
  status: WindowStatus,
  limitWarnMin: number,
): Promise<void> {
  if (status.effectiveRemainingMinutes <= limitWarnMin) {
    const tmpl =
      status.remainingReason === "burn_exhaustion" ? "burn_exhaustion" : "limit_approaching";
    const key: FiredKey = `${blockId}:${tmpl}`;
    if (fired.has(key)) return;
    fired.add(key);

    const vars: Record<string, string | number> =
      tmpl === "burn_exhaustion"
        ? {
            minutes_to_exhaustion: status.effectiveRemainingMinutes,
            window_end_hhmm: hhmm(status.endsAt),
          }
        : {
            remaining_min: status.effectiveRemainingMinutes,
          };

    await notifier.notify({ template: tmpl, severity: "warn", vars });
  }
}

function sleep(ms: number, isStopped: () => boolean): Promise<void> {
  return new Promise((resolve) => {
    const interval = 250;
    let elapsed = 0;
    const id = setInterval(() => {
      elapsed += interval;
      if (elapsed >= ms || isStopped()) {
        clearInterval(id);
        resolve();
      }
    }, interval);
  });
}

function nowHHMMSS(): string {
  const d = new Date();
  return [d.getHours(), d.getMinutes(), d.getSeconds()]
    .map((n) => String(n).padStart(2, "0"))
    .join(":");
}

function hhmm(d: Date): string {
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
