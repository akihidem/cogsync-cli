/**
 * state: store
 *
 * 最小 JSON 永続化（v0.2）。
 * 永続パス: ~/.local/state/cogsync/state.json （XDG_STATE_HOME 尊重）
 *
 * 将来 SQLite 移行する場合のため、Store インタフェースは v1.0 仕様に近い形で残す。
 * 現時点では単純な JSON 一式読み書き。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Phase, PhaseState } from "../coach/phase.ts";

export type PersistedState = {
  /** スキーマバージョン。今後増やす可能性あり */
  schema: 1;
  phase?: PhaseState | null;
  /** ディープワーク累積（DeepWorkAccumulator.toJSON() の戻り値） */
  deepWork?: { byDate: Record<string, number> } | null;
};

const EMPTY: PersistedState = { schema: 1, phase: null, deepWork: null };

export function defaultStatePath(): string {
  const xdg = process.env["XDG_STATE_HOME"];
  const base = xdg && xdg.length > 0 ? xdg : join(homedir(), ".local", "state");
  return join(base, "cogsync", "state.json");
}

export class JsonStore {
  constructor(private readonly path: string = defaultStatePath()) {}

  /** ファイルが無ければ作る（空で初期化） */
  ensure(): void {
    if (!existsSync(this.path)) {
      mkdirSync(dirname(this.path), { recursive: true });
      writeFileSync(this.path, JSON.stringify(EMPTY, null, 2));
    }
  }

  read(): PersistedState {
    this.ensure();
    const text = readFileSync(this.path, "utf8");
    try {
      const data = JSON.parse(text) as PersistedState;
      if (data.schema !== 1) {
        throw new Error(`unsupported state schema: ${data.schema}`);
      }
      return data;
    } catch (err) {
      throw new Error(
        `failed to parse state file ${this.path}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** 書き込みは temp file → rename で原子的 */
  write(state: PersistedState): void {
    this.ensure();
    const tmp = `${this.path}.tmp.${process.pid}`;
    writeFileSync(tmp, JSON.stringify(state, null, 2));
    renameSync(tmp, this.path);
  }

  setPhase(phase: Phase, now: Date = new Date()): PhaseState {
    const state = this.read();
    const next: PhaseState = { phase, startedAt: now };
    state.phase = next;
    this.write(state);
    return next;
  }

  getPhase(): PhaseState | null {
    return this.read().phase ?? null;
  }

  saveDeepWork(data: { byDate: Record<string, number> }): void {
    const state = this.read();
    state.deepWork = data;
    this.write(state);
  }

  loadDeepWork(): { byDate: Record<string, number> } | null {
    return this.read().deepWork ?? null;
  }

  get path_(): string {
    return this.path;
  }
}
