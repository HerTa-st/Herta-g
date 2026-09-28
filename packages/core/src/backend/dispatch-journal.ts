import { type FileHandle, mkdir, open, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
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

/** Where a session's journal lives: a `journal/` folder beside the session
 *  records, so the session listing (which reads `<id>.jsonl` there) never
 *  takes it for a session. */
export function dispatchJournalPath(
  transcriptDir: string,
  sessionId: string,
): string {
  return join(transcriptDir, "journal", `${sessionId}.jsonl`);
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
  readonly brief: HertaToAgentBrief;
  readonly frame: JournalFrameInputs;
}

/** How a process a call started relates to the call. */
export type JournalSpawnRole = "foreground" | "background" | "shell";

export type DispatchJournalEntry =
  | JournalStartEntry
  /** One transcript append: a steer, an assistant message with its calls,
   *  a tool result as the model saw it. */
  | { readonly kind: "message"; readonly message: Message }
  /** These calls passed their permission gate and are about to run. */
  | { readonly kind: "dispatch"; readonly callIds: readonly string[] }
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
    }
  | { readonly kind: "exit"; readonly pid: number }
  /** The harness's result for a call that had none (ADR 0071 §1.3). */
  | {
      readonly kind: "closer";
      readonly callId: string;
      readonly outcome: string;
      readonly result: ToolResult;
    }
  | { readonly kind: "resume"; readonly at: string }
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

export class DispatchJournal {
  private handle: FileHandle | null;
  private tail: Promise<void> = Promise.resolve();
  private failure: Error | null = null;

  private constructor(handle: FileHandle | null, failure: Error | null) {
    this.handle = handle;
    this.failure = failure;
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
      const journal = new DispatchJournal(handle, null);
      await journal.appendDurable(start);
      await syncDirectory(dirname(path));
      return journal;
    } catch (err) {
      await handle?.close().catch(() => undefined);
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
