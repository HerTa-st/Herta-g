import { execFile } from "node:child_process";

/**
 * MSYS's own process table (Git for Windows' bash). Windows' parent ids do
 * not describe an MSYS shell's work: running a command goes through
 * Cygwin's fork/exec emulation, and the forked process exits once it has
 * exec'd, so a command's Windows parent is a process that no longer exists.
 * Neither `taskkill /T` nor a parent-id walk gets past it — a job the shell
 * backgrounded outlived `kill()` (found 2026-09-28). MSYS keeps the real tree:
 * every command the shell starts stays in the shell's process group, and
 * `ps -e` names each one's Windows pid.
 */

export interface MsysRow {
  readonly pid: number;
  readonly ppid: number;
  readonly pgid: number;
  readonly winpid: number;
}

/** An MSYS shell's process group: its MSYS pid (the group's id — a shell a
 *  non-MSYS program starts leads its own group) and its Windows pid. */
export interface MsysGroup {
  readonly pgid: number;
  readonly winpid: number;
}

/** Every MSYS process. Rejects when `ps` cannot be run. */
export function listMsysProcesses(psPath: string): Promise<MsysRow[]> {
  return new Promise((resolve, reject) => {
    execFile(
      psPath,
      ["-e"],
      { windowsHide: true, timeout: 15_000, maxBuffer: 1 << 22 },
      (err, stdout) => {
        if (err !== null) {
          reject(err);
          return;
        }
        const rows: MsysRow[] = [];
        for (const line of stdout.split(/\r?\n/)) {
          // `PID PPID PGID WINPID …`, sometimes behind a one-letter status.
          const m = /^\s*[A-Z]?\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s/.exec(line);
          if (m !== null) {
            rows.push({
              pid: Number(m[1]),
              ppid: Number(m[2]),
              pgid: Number(m[3]),
              winpid: Number(m[4]),
            });
          }
        }
        resolve(rows);
      },
    );
  });
}

/**
 * The Windows pids of a shell's group: the shell and everything it started.
 * Empty when the group's id now names a different shell (the MSYS pid was
 * reused) — nothing in it is ours then.
 */
export function msysGroupWinpids(
  rows: readonly MsysRow[],
  group: MsysGroup,
): number[] {
  const leader = rows.find((r) => r.pid === group.pgid);
  if (leader !== undefined && leader.winpid !== group.winpid) return [];
  return rows.filter((r) => r.pgid === group.pgid).map((r) => r.winpid);
}
