import { unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  DispatchJournal,
  type DispatchJournalEntry,
  hashFile,
  type JournalHost,
  type JournalProcessFate,
  type LastTurnEnd,
  markJournalOpen,
  openDispatch,
  planSeal,
  readDispatchJournal,
  readJournalIndex,
  type SealPlan,
  type TerminalRecord,
  type TerminalRecordBlock,
} from "@herta/core";
import { buildCrashMarker } from "@herta/herta";
import {
  killProcesses,
  listMsysProcesses,
  listProcesses,
  type MsysRow,
  msysGroupWinpids,
  type ProcessRow,
  processTree,
  SAME_PROCESS_WINDOW_MS,
  sameProcessStart,
} from "@herta/tools";

/**
 * Recovering a 板砖 run the app exited during (ADR 0071 §1.2, §1.6): the
 * seal a session's open runs, the reaper a launch runs, and the drop a
 * rewind runs. Everything here is best effort around the session: a
 * failure leaves the session as it would have been without it.
 */

/** Reading processes — injectable, so the tests need not spawn. */
export interface ProcessProbe {
  /** Every running process; rejects when the table cannot be read. */
  processes(): Promise<readonly ProcessRow[]>;
  /** MSYS's own table, through the `ps` a journal recorded; rejects when it
   *  cannot be read. */
  msysProcesses(ps: string): Promise<readonly MsysRow[]>;
  /** End these processes. */
  kill(pids: readonly number[]): Promise<void>;
  /** Whether a pid runs at all (a cheap first check). */
  alive(pid: number): boolean;
  /** This process, as a journal names its host. */
  self(): JournalHost;
}

export const systemProcessProbe: ProcessProbe = {
  processes: listProcesses,
  msysProcesses: listMsysProcesses,
  kill: killProcesses,
  alive: (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      // EPERM: it runs, as someone else.
      return (err as { code?: unknown }).code === "EPERM";
    }
  },
  self: () => ({
    pid: process.pid,
    startedAt: Math.round(Date.now() - process.uptime() * 1000),
  }),
};

/**
 * Whose run a journal holds. "self": this process wrote it. "other": another
 * live process — a second app sharing the sessions — is running it; hands
 * off. "gone": its process is dead. "unknown": its pid runs and could not be
 * checked; treated as "other".
 */
async function hostState(
  host: JournalHost | undefined,
  probe: ProcessProbe,
): Promise<"self" | "other" | "gone" | "unknown"> {
  if (host === undefined) return "gone";
  const me = probe.self();
  if (host.pid === me.pid) {
    return sameProcessStart(host.startedAt, me.startedAt) ? "self" : "gone";
  }
  if (!probe.alive(host.pid)) return "gone";
  try {
    const row = (await probe.processes()).find((r) => r.pid === host.pid);
    if (row === undefined) return "gone";
    return sameProcessStart(host.startedAt, row.startedAt) ? "other" : "gone";
  } catch {
    return "unknown";
  }
}

function lastTerminalMarker(record: TerminalRecord): number {
  for (let i = record.length - 1; i >= 0; i -= 1) {
    const b = record[i];
    if (
      b?.kind === "system" &&
      (b.role === "done-marker" || b.role === "noop-marker")
    ) {
      return i;
    }
  }
  return -1;
}

export interface SealedOpen {
  readonly record: TerminalRecord;
  readonly lastTurnEnd: LastTurnEnd;
  readonly plan: SealPlan;
}

/**
 * Seal the session's run if the app exited during it (ADR 0071 §1.2). Runs
 * once per open, before anything else touches the session. Null — nothing
 * written — unless BOTH halves of the gate hold: the journal's run never
 * ended, and the record has no terminal marker since that run began. A
 * clean reload, a session sealed before, and a run still unwinding in this
 * process or live in another all come back null.
 *
 * Order, so a seal cut short is finished by the next open: the closers
 * into the journal, then the marker and `turn_end interrupted` into the
 * record, then the journal's `end`.
 */
export async function sealOpenDispatch(opts: {
  readonly journalPath: string;
  readonly record: TerminalRecord;
  readonly persister: {
    appendBlock(block: TerminalRecordBlock): void;
    appendTurnEnd?(
      outcome: "completed" | "interrupted" | "failed",
      at: string,
    ): void;
  };
  readonly now?: () => Date;
  readonly probe?: ProcessProbe;
}): Promise<SealedOpen | null> {
  const probe = opts.probe ?? systemProcessProbe;
  const entries = await readDispatchJournal(opts.journalPath);
  if (entries === null) return null;
  const open = openDispatch(entries);
  if (open === null) return null;
  const at = open.recordLength;
  if (
    at === undefined ||
    opts.record.length < at ||
    lastTerminalMarker(opts.record) >= at
  ) {
    return null;
  }
  if (DispatchJournal.isLive(opts.journalPath)) return null;
  const host = await hostState(open.start.host, probe);
  if (host === "other" || host === "unknown") return null;

  const plan = await planSeal(entries, hashFile);
  if (plan === null) return null;

  const journal = await DispatchJournal.reopen(opts.journalPath);
  try {
    for (const call of plan.calls) {
      if (call.journaled) continue;
      await journal.append({
        kind: "closer",
        callId: call.callId,
        outcome: call.outcome,
        result: call.result,
      });
    }
    if (journal.failed) return null;

    const stamp = (opts.now ?? (() => new Date()))().toISOString();
    const marker = {
      ...buildCrashMarker({
        steps: plan.calls.map((c) => ({ step: c.step, outcome: c.outcome })),
        changedFiles: plan.changedFiles,
      }),
      at: stamp,
    };
    opts.persister.appendBlock(marker);
    try {
      opts.persister.appendTurnEnd?.("interrupted", stamp);
    } catch {
      // The marker already ends the run for every reader; a missing
      // turn_end costs at most one regenerate check on the next open.
    }
    await journal.append({
      kind: "end",
      status: "interrupted",
      cause: "app-exit",
    });
    const record = [...opts.record, marker];
    return {
      record,
      lastTurnEnd: { outcome: "interrupted", atBlockCount: record.length },
      plan,
    };
  } finally {
    await journal.close();
  }
}

export interface ReapSummary {
  /** Journals whose processes were checked. */
  readonly journals: number;
  readonly fates: ReadonlyArray<{ pid: number; fate: JournalProcessFate }>;
}

/**
 * The launch reaper (ADR 0071 §1.6): for each journal the open index lists,
 * end the processes its run left running — a recorded process still running
 * AS THAT PROCESS (same pid, same start time), and whatever descends from
 * it (`processTree`: a launcher that exited with the app leaves the shell
 * and command it started) — and record what became of each. A run live in
 * this process or in another app is left alone. Each checked journal leaves
 * the index; one that could not be checked stays for the next launch.
 */
export async function reapOrphanedDispatches(
  journalDir: string,
  probe: ProcessProbe = systemProcessProbe,
): Promise<ReapSummary> {
  const fates: Array<{ pid: number; fate: JournalProcessFate }> = [];
  let journals = 0;
  // One read of the process table for the whole launch.
  let tableRead: Promise<readonly ProcessRow[]> | null = null;
  const rows = (): Promise<readonly ProcessRow[]> => {
    tableRead ??= probe.processes();
    return tableRead;
  };
  for (const name of await readJournalIndex(journalDir)) {
    const path = join(journalDir, name);
    if (DispatchJournal.isLive(path)) continue;
    const entries = await readDispatchJournal(path);
    if (entries === null) {
      await markJournalOpen(path, false);
      continue;
    }
    const start = entries[0]?.kind === "start" ? entries[0] : undefined;
    const host = await hostState(start?.host, probe);
    if (host !== "gone") continue;

    const targets = leftBehind(entries);
    const found: Array<{ pid: number; fate: JournalProcessFate }> = [];
    if (targets.length > 0) {
      let table: readonly ProcessRow[] | null;
      try {
        table = await rows();
      } catch {
        table = null;
      }
      for (const t of targets) {
        if (table === null) {
          found.push({ pid: t.pid, fate: "unverified" });
          continue;
        }
        const tree = await reachable(table, t, probe);
        if (tree.length === 0) {
          // Neither it nor anything it started still runs.
          found.push({ pid: t.pid, fate: "gone" });
          continue;
        }
        try {
          await probe.kill(tree);
          found.push({ pid: t.pid, fate: "ended" });
        } catch {
          found.push({ pid: t.pid, fate: "unverified" });
        }
      }
      const journal = await DispatchJournal.reopen(path);
      for (const f of found) {
        await journal.append({ kind: "reap", pid: f.pid, fate: f.fate });
      }
      await journal.close();
    }
    journals += 1;
    fates.push(...found);
    if (found.every((f) => f.fate !== "unverified")) {
      await markJournalOpen(path, false);
    }
  }
  return { journals, fates };
}

interface LeftBehind {
  readonly pid: number;
  readonly startedAt: number;
  readonly msys?: { readonly pgid: number; readonly ps: string };
}

/**
 * What still runs of a recorded process: the process and its descendants
 * (`processTree`), and for an MSYS shell every member of its process group
 * — Cygwin's fork/exec leaves a command's Windows parent dead, so only
 * MSYS's own table leads there. A member must be no older than the shell,
 * and its own descendants come along.
 */
async function reachable(
  table: readonly ProcessRow[],
  t: LeftBehind,
  probe: ProcessProbe,
): Promise<number[]> {
  const found = new Set(processTree(table, t));
  if (t.msys !== undefined) {
    let msys: readonly MsysRow[] = [];
    try {
      msys = await probe.msysProcesses(t.msys.ps);
    } catch {
      // No MSYS table: what the Windows table reached is all there is.
    }
    const byPid = new Map(table.map((r) => [r.pid, r]));
    for (const winpid of msysGroupWinpids(msys, {
      pgid: t.msys.pgid,
      winpid: t.pid,
    })) {
      const row = byPid.get(winpid);
      if (
        row === undefined ||
        row.startedAt + SAME_PROCESS_WINDOW_MS < t.startedAt
      ) {
        continue;
      }
      for (const pid of processTree(table, row)) found.add(pid);
    }
  }
  return [...found];
}

/** Processes a journal's run started that have neither exited nor been
 *  checked by a relaunch. */
function leftBehind(entries: readonly DispatchJournalEntry[]): LeftBehind[] {
  const done = new Set<number>();
  for (const e of entries) {
    if (e.kind === "exit" || e.kind === "reap") done.add(e.pid);
  }
  const out: LeftBehind[] = [];
  for (const e of entries) {
    if (e.kind === "spawn" && !done.has(e.pid)) {
      out.push({
        pid: e.pid,
        startedAt: e.startedAt,
        ...(e.msys !== undefined ? { msys: e.msys } : {}),
      });
      done.add(e.pid);
    }
  }
  return out;
}

/**
 * A rewind that withdrew the turn a run belongs to deletes the run's
 * journal (ADR 0071 §1.1), so it is never sealed or continued — unless its
 * processes still wait for the reaper, which needs it.
 */
export async function dropWithdrawnJournal(
  journalPath: string,
  recordLength: number,
): Promise<void> {
  const entries = await readDispatchJournal(journalPath);
  const start = entries?.[0];
  if (entries === null || start?.kind !== "start") return;
  if (start.recordLength === undefined || start.recordLength <= recordLength) {
    return;
  }
  if (DispatchJournal.isLive(journalPath)) return;
  const listed = (await readJournalIndex(dirname(journalPath))).includes(
    basename(journalPath),
  );
  if (listed && leftBehind(entries).length > 0) return;
  await unlink(journalPath).catch(() => undefined);
  if (listed) await markJournalOpen(journalPath, false);
}
