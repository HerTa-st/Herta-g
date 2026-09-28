import type { CutoffOutcome } from "../types/terminal-record.js";
import type { ToolCallRequest, ToolResult } from "../types/tool.js";
import type {
  DispatchJournalEntry,
  JournalProcessFate,
  JournalSpawnRole,
  JournalStartEntry,
} from "./dispatch-journal.js";

/**
 * Sealing a run the app exited during (ADR 0071 §1.2–§1.3): every call that
 * has no result is decided — by the harness, from the journal and the files
 * on disk, never by a prompt (D4) — and closed with a result the model reads
 * when the run is continued. Nothing is re-run.
 *
 * Pure apart from the injected file hash, so each row of §1.3 is a test.
 */

export interface SealedProcess {
  readonly callId: string;
  readonly pid: number;
  readonly startedAt: number;
  readonly command: string;
  readonly role: JournalSpawnRole;
  /** Absent until a relaunch has checked it (§1.6). */
  readonly fate?: JournalProcessFate;
}

export interface SealedCall {
  readonly callId: string;
  readonly tool: string;
  /** The tool and its target, for the marker: `edit_file src/a.ts`. */
  readonly step: string;
  readonly outcome: CutoffOutcome;
  /** This call's processes the run left behind. */
  readonly processes: readonly SealedProcess[];
  /** The persisted result the model reads (§1.5). */
  readonly result: ToolResult;
  /** Already in the journal: an earlier seal wrote its closer and then
   *  stopped before the record had its marker. */
  readonly journaled: boolean;
}

/** An open run: the `start`, and where its latest segment begins (the
 *  `start`, or the `resume` of a continued run). */
export interface OpenDispatch {
  readonly start: JournalStartEntry;
  readonly segment: number;
  /** The record's length when the segment began — the seal's record gate. */
  readonly recordLength: number | undefined;
}

export interface SealPlan extends OpenDispatch {
  /** Every call of the latest segment that has no result, decided. */
  readonly calls: readonly SealedCall[];
  /** Workspace-relative files the segment changed: its finished writes and
   *  the open writes found applied. */
  readonly changedFiles: readonly string[];
  /** The last finished todo list's unfinished items. */
  readonly openTodos: readonly string[];
  /** Processes the run left running (no `exit`), whichever call started
   *  them. */
  readonly processes: readonly SealedProcess[];
}

const WRITING_TOOLS: ReadonlySet<string> = new Set([
  "edit_file",
  "write_new_file",
  "str_replace_editor",
]);
const COMMAND_TOOLS: ReadonlySet<string> = new Set(["run_command", "bash"]);
const STATE_TOOLS: ReadonlySet<string> = new Set([
  "todo_write",
  "report_finding",
]);
const OUTCOMES: ReadonlySet<string> = new Set<CutoffOutcome>([
  "not_started",
  "read_interrupted",
  "write_applied",
  "write_not_applied",
  "write_changed_since",
  "state_not_applied",
  "outcome_unknown",
]);

/** The run when it is open — started or resumed, and not ended since —
 *  which is the journal's half of the seal's gate; else null. */
export function openDispatch(
  entries: readonly DispatchJournalEntry[],
): OpenDispatch | null {
  const first = entries[0];
  if (first?.kind !== "start") return null;
  let open = false;
  let segment = 0;
  let recordLength: number | undefined;
  entries.forEach((e, i) => {
    if (e.kind === "start" || e.kind === "resume") {
      open = true;
      segment = i;
      recordLength = e.recordLength;
    } else if (e.kind === "end") {
      open = false;
    }
  });
  return open ? { start: first, segment, recordLength } : null;
}

/**
 * Decide every open call of an open run. Null when the run is not open.
 * `hashFile` answers a file's sha256, or null when it does not exist; a
 * throw (the file cannot be read) leaves that write's outcome unknown.
 */
export async function planSeal(
  entries: readonly DispatchJournalEntry[],
  hashFile: (path: string) => Promise<string | null>,
): Promise<SealPlan | null> {
  const open = openDispatch(entries);
  if (open === null) return null;
  const { start } = open;
  const lang = start.frame.lang;
  const root = start.workspaceRoot;

  // The whole journal: processes outlive a segment, and so does the list.
  const spawns: SealedProcess[] = [];
  const exited = new Set<number>();
  const fates = new Map<number, JournalProcessFate>();
  const todoCalls = new Map<string, unknown>();
  let lastTodos: unknown;
  for (const e of entries) {
    if (e.kind === "spawn") {
      spawns.push({
        callId: e.callId,
        pid: e.pid,
        startedAt: e.startedAt,
        command: e.command,
        role: e.role,
      });
    } else if (e.kind === "exit") {
      exited.add(e.pid);
    } else if (e.kind === "reap") {
      fates.set(e.pid, e.fate);
    } else if (e.kind === "message" && e.message.role === "assistant") {
      for (const c of e.message.toolCalls) {
        if (c.tool === "todo_write") todoCalls.set(c.id, c.input);
      }
    } else if (
      e.kind === "message" &&
      e.message.role === "tool" &&
      e.message.result.ok &&
      todoCalls.has(e.message.toolCallId)
    ) {
      lastTodos = todoCalls.get(e.message.toolCallId);
    }
  }
  const leftRunning = spawns
    .filter((s) => !exited.has(s.pid))
    .map((s) => {
      const fate = fates.get(s.pid);
      return fate !== undefined ? { ...s, fate } : s;
    });

  // The latest segment: its calls, what answered them, what they did.
  const calls: ToolCallRequest[] = [];
  const results = new Map<string, boolean>(); // callId → ok
  const closers = new Map<
    string,
    { outcome: CutoffOutcome; result: ToolResult }
  >();
  const dispatched = new Map<string, boolean>(); // callId → readOnly
  const writes = new Map<
    string,
    { path: string; before: string | null; after: string }
  >();
  for (const e of entries.slice(open.segment)) {
    switch (e.kind) {
      case "message":
        if (e.message.role === "assistant") {
          calls.push(...e.message.toolCalls);
        } else if (e.message.role === "tool") {
          results.set(e.message.toolCallId, e.message.result.ok);
        }
        break;
      case "closer":
        if (OUTCOMES.has(e.outcome)) {
          closers.set(e.callId, {
            outcome: e.outcome as CutoffOutcome,
            result: e.result,
          });
        }
        break;
      case "dispatch":
        for (const id of e.callIds) dispatched.set(id, e.readOnly === true);
        break;
      case "write":
        writes.set(e.callId, {
          path: e.path,
          before: e.before,
          after: e.after,
        });
        break;
      default:
        break;
    }
  }

  const sealed: SealedCall[] = [];
  const changed: string[] = [];
  for (const call of calls) {
    const w = writes.get(call.id);
    if (results.has(call.id)) {
      if (results.get(call.id) === true && w !== undefined) {
        changed.push(relativeTo(root, w.path));
      }
      continue;
    }
    const processes = leftRunning.filter((p) => p.callId === call.id);
    const prior = closers.get(call.id);
    const outcome =
      prior?.outcome ?? (await decide(call, dispatched, w, hashFile));
    const path = w !== undefined ? relativeTo(root, w.path) : undefined;
    if (outcome === "write_applied" && path !== undefined) changed.push(path);
    sealed.push({
      callId: call.id,
      tool: call.tool,
      step: stepOf(call, path),
      outcome,
      processes,
      result:
        prior?.result ??
        closerResult(outcome, call.tool, path, processes, lang),
      journaled: prior !== undefined,
    });
  }

  return {
    ...open,
    calls: sealed,
    changedFiles: [...new Set(changed)],
    openTodos: unfinishedTodos(lastTodos),
    processes: leftRunning,
  };
}

async function decide(
  call: ToolCallRequest,
  dispatched: ReadonlyMap<string, boolean>,
  write: { path: string; before: string | null; after: string } | undefined,
  hashFile: (path: string) => Promise<string | null>,
): Promise<CutoffOutcome> {
  if (!dispatched.has(call.id)) return "not_started";
  if (dispatched.get(call.id) === true) return "read_interrupted";
  if (WRITING_TOOLS.has(call.tool)) {
    // The minimal contract's editor also views; a view writes nothing.
    if (
      call.tool === "str_replace_editor" &&
      (call.input as { command?: unknown } | null)?.command === "view"
    ) {
      return "read_interrupted";
    }
    // The rename only ever follows the entry, so no entry means no write.
    if (write === undefined) return "write_not_applied";
    let now: string | null;
    try {
      now = await hashFile(write.path);
    } catch {
      return "outcome_unknown";
    }
    if (now === write.after) return "write_applied";
    if (now === write.before) return "write_not_applied";
    return "write_changed_since";
  }
  if (STATE_TOOLS.has(call.tool)) return "state_not_applied";
  return "outcome_unknown";
}

/** `edit_file src/a.ts`, `run_command npm test`, or the bare tool name. */
function stepOf(call: ToolCallRequest, path: string | undefined): string {
  const input = (call.input ?? {}) as Record<string, unknown>;
  const target =
    path ??
    (COMMAND_TOOLS.has(call.tool) && typeof input.command === "string"
      ? oneLine(input.command)
      : typeof input.path === "string"
        ? input.path
        : undefined);
  return target !== undefined && target.length > 0
    ? `${call.tool} ${target}`
    : call.tool;
}

function oneLine(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
}

function unfinishedTodos(input: unknown): string[] {
  const todos = (input as { todos?: unknown } | null | undefined)?.todos;
  if (!Array.isArray(todos)) return [];
  return todos
    .filter(
      (t): t is { content: string; status?: unknown } =>
        typeof (t as { content?: unknown })?.content === "string",
    )
    .filter((t) => t.status !== "completed")
    .map((t) => t.content);
}

/**
 * The result an open call is closed with. `ok` only for a write found
 * applied — the tool's work stands; every other outcome says what did not
 * happen, or that nobody can know.
 */
function closerResult(
  outcome: CutoffOutcome,
  tool: string,
  path: string | undefined,
  processes: readonly SealedProcess[],
  lang: "zh" | "en",
): ToolResult {
  const text = closerText(outcome, tool, path, processes, lang);
  if (outcome === "write_applied") {
    return {
      ok: true,
      summary: "applied before the app exited",
      modelText: text,
    };
  }
  return {
    ok: false,
    error: { code: `app_exit_${outcome}`, message: text, retryable: false },
    summary: `app exited: ${outcome.replaceAll("_", " ")}`,
    modelText: text,
  };
}

function closerText(
  outcome: CutoffOutcome,
  tool: string,
  path: string | undefined,
  processes: readonly SealedProcess[],
  lang: "zh" | "en",
): string {
  const file = path ?? (lang === "en" ? "the file" : "该文件");
  const command = COMMAND_TOOLS.has(tool);
  const zh: Record<CutoffOutcome, string> = {
    not_started: "应用退出时这一步还没有开始执行。如仍需要，重新调用。",
    read_interrupted:
      "应用退出时这次读取没有完成。它没有副作用，需要时重新读取。",
    write_applied: `应用退出前这次写入已经完成：${file} 现在是写入后的内容。不要重复这次修改。`,
    write_not_applied: `应用退出前这次写入没有落盘：${file} 仍是原来的内容。如仍需要，先重新读取再修改。`,
    write_changed_since: `${file} 的内容既不是写入前、也不是写入后的版本：应用退出后它被别处改动过。先读取它，不要覆盖那次改动；如果影响任务，用 report_finding 说明。`,
    state_not_applied:
      "应用退出时这一步没有生效（已完成的步骤都已恢复）。如仍需要，重新调用。",
    outcome_unknown: command
      ? "应用退出时这条命令正在运行，结果未知，输出没有保留；它可能已经部分执行。不要直接重跑有副作用的命令：先检查它影响的状态（文件、git status、进程、端口），或只重跑只读、可重复执行的命令。"
      : "应用退出时这一步正在执行，结果未知；它可能已经部分生效。先确认它影响的状态，再决定是否重做。",
  };
  const en: Record<CutoffOutcome, string> = {
    not_started:
      "This step had not started when the app exited. Call it again if it is still needed.",
    read_interrupted:
      "This read did not finish before the app exited. It has no side effect; read again if needed.",
    write_applied: `This write completed before the app exited: ${file} holds the written content. Do not repeat the change.`,
    write_not_applied: `This write did not reach the disk before the app exited: ${file} is unchanged. If it is still needed, read the file again before editing it.`,
    write_changed_since: `${file} is neither the version before this write nor the one after it: it was changed elsewhere after the app exited. Read it first and do not overwrite that change; if it matters to the task, say so with report_finding.`,
    state_not_applied:
      "This step did not take effect when the app exited (every finished step was restored). Call it again if it is still needed.",
    outcome_unknown: command
      ? "This command was running when the app exited. Its outcome is unknown and its output was not kept; it may have partly run. Do not simply re-run a command with side effects: first check the state it touches (files, git status, processes, ports), or re-run only a read-only or idempotent command."
      : "This step was running when the app exited; its outcome is unknown and it may have partly taken effect. Check the state it touches before deciding to redo it.",
  };
  const base = (lang === "en" ? en : zh)[outcome];
  const lines = processes.map((p) => processLine(p, lang));
  return lines.length > 0 ? `${base}\n${lines.join("\n")}` : base;
}

/** One line about a process the run left running (§1.6). */
export function processLine(p: SealedProcess, lang: "zh" | "en"): string {
  const zh: Record<JournalProcessFate | "unchecked", string> = {
    ended: `进程 ${p.pid}（${p.command}）在应用重新启动时仍在运行，已被结束。`,
    gone: `进程 ${p.pid}（${p.command}）在应用重新启动时已不在运行。`,
    unverified: `无法确认进程 ${p.pid} 仍是这条命令（${p.command}），所以没有结束它；它可能仍在运行。`,
    unchecked: `进程 ${p.pid}（${p.command}）在应用退出时仍在运行，尚未检查。`,
  };
  const en: Record<JournalProcessFate | "unchecked", string> = {
    ended: `Process ${p.pid} (${p.command}) was still running at relaunch and was ended.`,
    gone: `Process ${p.pid} (${p.command}) was no longer running at relaunch.`,
    unverified: `Process ${p.pid} could not be confirmed to still be this command (${p.command}), so it was not ended; it may still be running.`,
    unchecked: `Process ${p.pid} (${p.command}) was running when the app exited and has not been checked.`,
  };
  return (lang === "en" ? en : zh)[p.fate ?? "unchecked"];
}

/** A journal path relative to the run's workspace, `/`-separated; the path
 *  as recorded when it lies elsewhere or the workspace is unknown. */
function relativeTo(root: string | undefined, path: string): string {
  if (root === undefined) return path;
  const norm = (s: string) => s.replaceAll("\\", "/");
  const r = norm(root).replace(/\/+$/, "");
  const p = norm(path);
  const inside =
    process.platform === "win32"
      ? p.toLowerCase().startsWith(`${r.toLowerCase()}/`)
      : p.startsWith(`${r}/`);
  return inside ? p.slice(r.length + 1) : path;
}
