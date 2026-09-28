import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { type FileHandle, mkdir, open, readFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { writeFileAtomic } from "../atomic-write.js";
import type { HertaToAgentBrief } from "../bridge/types.js";
import type { ToolCallJournal, ToolResult } from "../types/tool.js";
import type { Message } from "../types/transcript.js";
import type { RepoContextSnapshot } from "./backend-context-builder.js";

/**
 * A 板砖 run's journal (ADR 0071 §1.1): what the run did, in order, written
 * so that a run the app died in the middle of can be sealed and continued.
 * Machine-only — never shown, never in Herta's prompt; the record stays the
 * user-facing projection (D2, D7).
 *
 * One file per session, beside its record, holding the LATEST dispatch: a
 * new dispatch replaces it. Everything with a side effect is made durable
 * BEFORE it happens (a mutating call's `dispatch`, a file `write`), and a
 * journal that cannot be made durable stops the side effect (fail-closed,
 * as DSH does). Writes are asynchronous: 板砖 runs on the desktop app's main
 * thread (ADR 0068).
 */

export const DISPATCH_JOURNAL_VERSION = 1;

/** A file's sha256 (hex), or null when it does not exist — how the seal and
 *  a continued run decide a write the journal recorded (ADR 0071 §1.3). */
export function hashFile(path: string): Promise<string | null> {
  return new Promise((resolvePromise, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolvePromise(hash.digest("hex")));
    stream.on("error", (err) => {
      if ((err as { code?: unknown }).code === "ENOENT") resolvePromise(null);
      else reject(err);
    });
  });
}

/** Where a session's journal lives: a `journal/` folder beside the session
 *  records, so the session listing (which reads `<id>.jsonl` there) never
 *  takes it for a session. */
export function dispatchJournalPath(
  transcriptDir: string,
  sessionId: string,
): string {
  return join(dispatchJournalDir(transcriptDir), `${sessionId}.jsonl`);
}

/** The folder holding every session's journal, and the open index. */
export function dispatchJournalDir(transcriptDir: string): string {
  return join(transcriptDir, "journal");
}

/** Every input of the backend frame a run was built from, so a resumed run
 *  rebuilds the same base frame (ADR 0071 §1.5). */
export interface JournalFrameInputs {
  readonly userMessages: ReadonlyArray<{ text: string }>;
  readonly omittedUserMessages: number;
  readonly scopedRepoInstructions: string;
  readonly scopedMemory: string;
  readonly recentDialogue: string;
  readonly workingHistory: string;
  readonly lang: "zh" | "en";
  readonly repoContext?: RepoContextSnapshot;
}

export interface JournalStartEntry {
  readonly kind: "start";
  readonly v: number;
  readonly taskId: string;
  readonly at: string;
  /** The execution contract the run started with (ADR 0040). */
  readonly contract?: string;
  /** The session record's length when the run was dispatched — the seal's
   *  second gate (ADR 0071 §1.2). */
  readonly recordLength?: number;
  /** The run's workspace; the seal names the files it wrote relative to it. */
  readonly workspaceRoot?: string;
  /** The process that ran it. A run whose process is still alive is not
   *  sealed or reaped by another (a second app sharing the sessions). */
  readonly host?: JournalHost;
  readonly brief: HertaToAgentBrief;
  readonly frame: JournalFrameInputs;
}

/** A process and when it started (epoch ms), for an identity check. */
export interface JournalHost {
  readonly pid: number;
  readonly startedAt: number;
}

/** This process, as a journal names it. */
export function currentJournalHost(): JournalHost {
  return {
    pid: process.pid,
    startedAt: Math.round(Date.now() - process.uptime() * 1000),
  };
}

/** How a process a call started relates to the call. */
export type JournalSpawnRole = "foreground" | "background" | "shell";

/** What a relaunch found for a process a run left behind (ADR 0071 §1.6):
 *  still running and ended, already gone, or not confirmably the same
 *  process — so left alone. */
export type JournalProcessFate = "ended" | "gone" | "unverified";

export type DispatchJournalEntry =
  | JournalStartEntry
  /** One transcript append: a steer, an assistant message with its calls,
   *  a tool result as the model saw it. */
  | { readonly kind: "message"; readonly message: Message }
  /** These calls passed their permission gate and are about to run.
   *  `readOnly` when every one of them is a read-only tool. */
  | {
      readonly kind: "dispatch";
      readonly callIds: readonly string[];
      readonly readOnly?: true;
    }
  /** A writer is about to replace a file (the path is absolute). */
  | {
      readonly kind: "write";
      readonly callId: string;
      readonly path: string;
      readonly before: string | null;
      readonly after: string;
    }
  /** A process was started; `startedAt` is epoch ms, for the identity check
   *  before a relaunch ends it (ADR 0071 §1.6). */
  | {
      readonly kind: "spawn";
      readonly callId: string;
      readonly pid: number;
      readonly startedAt: number;
      readonly command: string;
      readonly role: JournalSpawnRole;
      /** An MSYS shell's process group and the `ps` that lists it: Cygwin's
       *  fork/exec leaves a command's Windows parent dead, so only MSYS's
       *  own table leads from the shell to what it started. */
      readonly msys?: { readonly pgid: number; readonly ps: string };
    }
  | { readonly kind: "exit"; readonly pid: number }
  /** A relaunch checked a process the run left behind (ADR 0071 §1.6). */
  | {
      readonly kind: "reap";
      readonly pid: number;
      readonly fate: JournalProcessFate;
    }
  /** The harness's result for a call that had none (ADR 0071 §1.3). */
  | {
      readonly kind: "closer";
      readonly callId: string;
      readonly outcome: string;
      readonly result: ToolResult;
    }
  /** A sealed run continued (ADR 0071 §1.5); `recordLength` as on
   *  `start`. */
  | {
      readonly kind: "resume";
      readonly at: string;
      readonly recordLength?: number;
    }
  | {
      readonly kind: "end";
      readonly status: string;
      readonly cause?: "app-exit";
    };

const KINDS: ReadonlySet<string> = new Set([
  "start",
  "message",
  "dispatch",
  "write",
  "spawn",
  "exit",
  "reap",
  "closer",
  "resume",
  "end",
]);

/**
 * The result a call gets when the journal could not record it: the step is
 * NOT performed. Shared by the loop (a mutating call's `dispatch`) and the
 * writers (a file's `write`).
 */
export function journalUnavailableResult(reason: string): ToolResult {
  return {
    ok: false,
    error: {
      code: "journal_unavailable",
      message: `this step was not performed: the run's journal could not record it (${reason})`,
      retryable: false,
    },
    suggestion:
      "the harness cannot record changes right now, so it refuses them; do not retry this step — finish with what you have and say what is blocked",
    summary: "failed: journal_unavailable",
  };
}

/** Journals a run in THIS process holds open. A live one belongs to a run
 *  still unwinding — a session reopened before its close settled — and is
 *  neither sealed nor reaped (ADR 0071 §1.2). */
const LIVE = new Set<string>();

export class DispatchJournal {
  private handle: FileHandle | null;
  private tail: Promise<void> = Promise.resolve();
  private failure: Error | null = null;
  private readonly key: string | null;

  private constructor(
    handle: FileHandle | null,
    failure: Error | null,
    key: string | null = null,
  ) {
    this.handle = handle;
    this.failure = failure;
    this.key = key;
    if (key !== null) LIVE.add(key);
  }

  /** True while a journal at `path` is open in this process. */
  static isLive(path: string): boolean {
    return LIVE.has(liveKey(path));
  }

  /**
   * Start a new journal at `path`, replacing whatever was there, with the
   * `start` entry durable before this resolves. Never rejects: a journal
   * that cannot be created comes back failed, so every durable append
   * rejects and no side effect runs unrecorded.
   */
  static async begin(
    path: string,
    start: JournalStartEntry,
  ): Promise<DispatchJournal> {
    let handle: FileHandle | null = null;
    try {
      await mkdir(dirname(path), { recursive: true });
      handle = await open(path, "w");
      const journal = new DispatchJournal(handle, null, liveKey(path));
      await journal.appendDurable(start);
      await syncDirectory(dirname(path));
      return journal;
    } catch (err) {
      if (handle !== null) LIVE.delete(liveKey(path));
      await handle?.close().catch(() => undefined);
      return new DispatchJournal(null, asError(err));
    }
  }

  /**
   * Open an existing journal to append to it: a seal's closers, a reaper's
   * findings, a continued run. Only a continued run is `live` — a seal or a
   * reaper appending does not make the run a running one. Never rejects; a
   * journal that cannot be opened comes back failed, like `begin`'s.
   */
  static async reopen(
    path: string,
    opts: { readonly live?: boolean } = {},
  ): Promise<DispatchJournal> {
    try {
      const handle = await open(path, "a");
      return new DispatchJournal(
        handle,
        null,
        opts.live === true ? liveKey(path) : null,
      );
    } catch (err) {
      return new DispatchJournal(null, asError(err));
    }
  }

  /** True once a write failed (or the journal never opened): from then on
   *  nothing more is written and every durable append rejects. */
  get failed(): boolean {
    return this.failure !== null;
  }

  /** Queue an entry. Never rejects; a failure latches (see `failed`). */
  append(entry: DispatchJournalEntry): Promise<void> {
    return this.enqueue(entry, false).catch(() => undefined);
  }

  /** Queue an entry and sync it to disk. Rejects when it could not be made
   *  durable — the caller must then not perform the side effect. */
  appendDurable(entry: DispatchJournalEntry): Promise<void> {
    return this.enqueue(entry, true);
  }

  /** The per-call view a tool records through (`ToolContext.journal`). */
  forCall(callId: string): ToolCallJournal {
    return {
      recordWrite: (w) =>
        this.appendDurable({
          kind: "write",
          callId,
          path: w.path,
          before: w.before,
          after: w.after,
        }),
      recordSpawn: (s) => {
        // Best effort: the process is already running, and the call's own
        // durable `dispatch` already makes its outcome "unknown" on a seal.
        void this.appendDurable({
          kind: "spawn",
          callId,
          pid: s.pid,
          startedAt: Date.now(),
          command: s.command,
          role: s.role,
          ...(s.msys !== undefined ? { msys: s.msys } : {}),
        }).catch(() => undefined);
      },
      recordExit: (pid) => {
        void this.append({ kind: "exit", pid });
      },
    };
  }

  /** Wait for every queued entry, then release the file. */
  async close(): Promise<void> {
    await this.tail;
    const handle = this.handle;
    this.handle = null;
    await handle?.close().catch(() => undefined);
    if (this.key !== null) LIVE.delete(this.key);
  }

  private enqueue(entry: DispatchJournalEntry, sync: boolean): Promise<void> {
    const write = async (): Promise<void> => {
      if (this.failure !== null) throw this.failure;
      const handle = this.handle;
      if (handle === null) throw new Error("the journal is closed");
      try {
        await handle.appendFile(`${JSON.stringify(entry)}\n`, "utf8");
        if (sync) await handle.sync();
      } catch (err) {
        this.failure = asError(err);
        throw this.failure;
      }
    };
    const result = this.tail.then(write, write);
    this.tail = result.catch(() => undefined);
    return result;
  }
}

/**
 * Read a journal back. Null when there is none. A torn last line (the app
 * died mid-write) and any line that is not a journal entry are skipped: the
 * entries before them are still the run's own, in order.
 */
export async function readDispatchJournal(
  path: string,
): Promise<DispatchJournalEntry[] | null> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return null;
  }
  return parseDispatchJournal(text);
}

/** The entries in a journal's text (see `readDispatchJournal`). Pure. */
export function parseDispatchJournal(text: string): DispatchJournalEntry[] {
  const entries: DispatchJournalEntry[] = [];
  for (const line of text.split("\n")) {
    if (line.trim().length === 0) continue;
    try {
      const value: unknown = JSON.parse(line);
      if (
        typeof value === "object" &&
        value !== null &&
        typeof (value as { kind?: unknown }).kind === "string" &&
        KINDS.has((value as { kind: string }).kind)
      ) {
        entries.push(value as DispatchJournalEntry);
      }
    } catch {
      // a torn tail — skip it
    }
  }
  return entries;
}

/**
 * The index of journals whose run may have left processes behind (ADR 0071
 * §1.6): `open.json` beside the journals, a list of their file names. A run
 * is listed when it starts and unlisted when it ends normally — its own
 * cleanup stopped its processes. A run the app exited during stays listed
 * (the seal does not unlist it) until the launch reaper has checked its
 * processes. So a relaunch reads a handful of journals, not every session's.
 */
export function openJournalIndexPath(journalDir: string): string {
  return join(journalDir, "open.json");
}

let indexChain: Promise<void> = Promise.resolve();

/** Add a journal to, or drop it from, its folder's index. Serialized in
 *  this process; never rejects (the index is a hint the reaper reads, and a
 *  missed entry costs an orphan, not a wrong result). */
export function markJournalOpen(path: string, open: boolean): Promise<void> {
  const run = async (): Promise<void> => {
    const index = openJournalIndexPath(dirname(path));
    const name = basename(path);
    const names = new Set(await readJournalIndex(dirname(path)));
    if (open === names.has(name)) return;
    if (open) names.add(name);
    else names.delete(name);
    await mkdir(dirname(index), { recursive: true });
    await writeFileAtomic(index, `${JSON.stringify([...names])}\n`);
  };
  const next = indexChain.then(run, run);
  indexChain = next.catch(() => undefined);
  return next.catch(() => undefined);
}

/** The journal file names the index lists ([] when there is none). */
export async function readJournalIndex(journalDir: string): Promise<string[]> {
  try {
    const value: unknown = JSON.parse(
      await readFile(openJournalIndexPath(journalDir), "utf8"),
    );
    return Array.isArray(value)
      ? value.filter(
          (n): n is string =>
            typeof n === "string" && n.endsWith(".jsonl") && basename(n) === n,
        )
      : [];
  } catch {
    return [];
  }
}

function liveKey(path: string): string {
  const full = resolve(path);
  return process.platform === "win32" ? full.toLowerCase() : full;
}

/** A new file's directory entry is durable only once its directory is
 *  synced (POSIX). Windows cannot open a directory for this, and NTFS
 *  journals the metadata anyway. Best effort. */
async function syncDirectory(dir: string): Promise<void> {
  if (process.platform === "win32") return;
  let handle: FileHandle | null = null;
  try {
    handle = await open(dir, "r");
    await handle.sync();
  } catch {
    // best effort
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function asError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}
