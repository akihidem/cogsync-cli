/**
 * util: single-instance lock（O_EXCL pidfile）
 *
 * cogsync watch のような常駐プロセスを「1 マシン 1 本」に制限する。
 * 起動方法（bashrc / systemd / 手動）に依らず多重起動を防ぐため watch 本体でロックを取る。
 * 外部依存（flock 等）は使わず、O_EXCL での pidfile 作成（アトミック）＋死活チェックで
 * stale（保持者が死亡したまま残ったロック）を自動回収する。
 */

import { openSync, writeSync, closeSync, readFileSync, unlinkSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type LockHandle = {
  readonly path: string;
  /** ロックファイルを削除して解放する（多重呼び出し安全）。 */
  release: () => void;
};

/** 指定 pid が生存しているか。ESRCH=不在、EPERM=存在（権限なし）。 */
function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0); // signal 0 は存在確認のみ（実際にはシグナルを送らない）
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * single-instance ロックを取得する。
 * - 取れたら LockHandle を返す（呼び出し側はそのまま処理を続ける）。
 * - 既に生存中の他プロセスが保持していれば null（呼び出し側は終了する想定）。
 * stale な pidfile は回収して取り直す。アトミックな O_EXCL なので競合しても取得は最大 1 本。
 */
export function acquireSingleInstanceLock(lockPath: string): LockHandle | null {
  mkdirSync(dirname(lockPath), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(lockPath, "wx"); // wx = O_CREAT|O_EXCL: 既存なら EEXIST で失敗
      writeSync(fd, String(process.pid));
      closeSync(fd);
      return { path: lockPath, release: makeReleaser(lockPath) };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      // 既存ロックあり: 保持者の生死を確認する
      let holderPid = 0;
      try {
        holderPid = Number(readFileSync(lockPath, "utf8").trim());
      } catch {
        holderPid = 0; // 読めない/壊れている → stale 扱い
      }
      if (isProcessAlive(holderPid)) return null; // 本当に稼働中 → 取得失敗
      // stale: 回収して次の attempt で取り直す（競合で先に消えていても OK）
      try {
        unlinkSync(lockPath);
      } catch {
        /* already gone */
      }
    }
  }
  // 2 回試しても取れない（激しい競合）→ 安全側に倒して取得失敗扱い
  return null;
}

function makeReleaser(lockPath: string): () => void {
  let released = false;
  const remove = (): void => {
    if (released) return;
    released = true;
    try {
      // 自分の pid が書いた場合だけ消す（死亡後に別プロセスが取り直したロックを誤って消さない）。
      const pid = Number(readFileSync(lockPath, "utf8").trim());
      if (pid === process.pid) unlinkSync(lockPath);
    } catch {
      /* 既に無ければ何もしない */
    }
  };
  // 注意: SIGINT/SIGTERM ハンドラはここで登録しない。登録すると呼び出し側の終了処理
  // （例: watch の stop = deepwork 保存）より先に発火し、process.exit() で保存を奪う回帰になる。
  // シグナルは呼び出し側に委ね、本ロックは「プロセス終了時にロックファイルを消す」のみに徹する。
  // exit イベントは正常終了・明示 process.exit の双方で発火する（同期処理のみ可）。
  process.once("exit", remove);
  return remove;
}
