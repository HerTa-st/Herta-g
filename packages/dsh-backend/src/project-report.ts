import { isAbsolute, relative as relativePath } from "node:path";
import type {
  AgentExecutionReport,
  ChangedFileSummary,
  EvidenceItem,
  ExecutionStatus,
  TestRunSummary,
} from "@herta/core";
import type {
  DshContentBlock,
  DshSessionEvent,
  DshTurnReason,
} from "./events.js";
/**
 * Reads the structured reason off a `turn/end`, ignoring the bare-string
 * reasons that `step/end` and `request/header` carry under the same key.
 */
export function turnReasonOf(
  event: DshSessionEvent | undefined,
): DshTurnReason | undefined {
  const reason = event?.data?.reason;
  if (typeof reason !== "object" || reason === null) return undefined;
  return typeof reason.kind === "string"
    ? (reason as DshTurnReason)
    : undefined;
}

/**
 * Maps a DSH `turn/end` reason onto Herta's `ExecutionStatus`.
 *
 * `interrupted` is deliberately not produced here: the wire protocol has no
 * cancel — a user Stop in Herta aborts the local wait, it does not stop the
 * harness turn. Reporting `interrupted` would record a Stop that never
 * reached the backend as a backend outcome.
 */
export function statusFromTurnReason(
  reason: DshTurnReason | undefined,
): ExecutionStatus {
  switch (reason?.kind) {
    case "completed":
      return "completed";
    case undefined:
      return "partial";
    default:
      return "failed";
  }
}

/** One `tool/call` paired with the `tool/result` that answered it. */
export interface ToolReceipt {
  readonly name: string;
  readonly callId?: string;
  /** The `command` argument of a shell call, when the tool had one. */
  readonly command?: string;
  readonly isError: boolean;
  readonly text: string;
}

export interface ToolReceipts {
  readonly receipts: readonly ToolReceipt[];
  readonly unmatchedCalls: readonly string[];
}

/**
 * Pairs tool calls with their results and drops the orphans.
 *
 * An unmatched call means the turn ended mid-tool (harness crash, budget
 * exhaustion, timeout). Reporting it as a receipt would claim work that never
 * reported back, so unmatched calls surface through `residualRisks` instead.
 */
export function collectToolReceipts(
  events: readonly DshSessionEvent[],
): ToolReceipts {
  const resultsByCallId = new Map<string, { isError: boolean; text: string }>();

  for (const event of events) {
    if (event.type !== "tool/result") continue;
    const message = event.data?.message;
    if (message?.source?.kind !== "tool") continue;
    const callId = message.source.callId;
    if (callId === undefined) continue;
    const block = message.content?.find(
      (
        candidate,
      ): candidate is Extract<DshContentBlock, { type: "tool-result" }> =>
        candidate.type === "tool-result",
    );
    resultsByCallId.set(callId, {
      isError: block?.isError === true,
      text: block === undefined ? "" : plainText(block.content),
    });
  }

  const receipts: ToolReceipt[] = [];
  const unmatchedCalls: string[] = [];
  for (const event of events) {
    if (event.type !== "tool/call") continue;
    const name = event.data?.name ?? "tool";
    const callId = event.data?.callId;
    const result =
      callId === undefined ? undefined : resultsByCallId.get(callId);
    if (result === undefined || callId === undefined) {
      unmatchedCalls.push(name);
      continue;
    }
    receipts.push({
      name,
      callId,
      command: parseToolCallCommand(event.data?.arguments),
      isError: result.isError,
      text: result.text,
    });
  }

  return { receipts, unmatchedCalls };
}

/** Concatenates the `text` blocks of a payload, skipping reasoning. */
function plainText(blocks: readonly DshContentBlock[]): string {
  return blocks
    .map((block) => (block.type === "text" ? block.text : ""))
    .filter((text) => text.length > 0)
    .join("\n");
}

/**
 * `tool/call.arguments` is a JSON-encoded string, per the observed wire shape
 * — so a malformed blob must degrade to `undefined` rather than throw.
 */
export function parseToolCallCommand(
  raw: string | undefined,
): string | undefined {
  if (raw === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null && "command" in parsed) {
      const command = (parsed as { command?: unknown }).command;
      if (typeof command === "string") return command;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/** The harness's own tool inventory for the turn — `request/header.tools`. */
export function declaredToolNames(
  events: readonly DshSessionEvent[],
): readonly string[] {
  for (const event of events) {
    if (event.type !== "request/header") continue;
    const tools = event.data?.header?.tools;
    if (tools !== undefined) return tools.map((tool) => tool.name);
  }
  return [];
}

/**
 * The file artifacts a DSH shell receipt accounts for.
 *
 * DSH's `sdk-minimal` profile exposes exactly one tool — `pwsh` — so file
 * writes arrive as shell text, never as structured write results the way
 * Herta's own `edit_file` reports them. Recovering paths is therefore
 * heuristic, and deliberately conservative: a path is only accepted from an
 * explicit `-Path`/`-FilePath`/`-LiteralPath` switch, or from the positional
 * slot right after the verb. `New-Item -ItemType File x.txt` yields nothing
 * rather than guessing `File`, because 变更文件 is what Herta narrates as fact.
 */
export function changedFilesFromReceipts(
  receipts: readonly ToolReceipt[],
  workspace?: string,
): readonly ChangedFileSummary[] {
  const byPath = new Map<string, ChangedFileSummary>();

  for (const receipt of receipts) {
    if (receipt.isError || receipt.command === undefined) continue;
    for (const written of writtenPaths(receipt.command)) {
      // Relativise before dedup: `E:\ws\a.txt` and `a.txt` name one file.
      const path = relativeToWorkspace(written, workspace);
      if (byPath.has(path)) continue;
      byPath.set(path, {
        path,
        kind: "modified",
        diffSummary: `written via ${receipt.name}`,
      });
    }
  }

  return [...byPath.values()];
}

/** A write verb plus the rest of its statement, stopping at `;` / `|` / newline. */
const WRITE_STATEMENT =
  /(?:^|[\s|;(])(?:Set-Content|Add-Content|Out-File|New-Item)\b([^\n;|]*)/giu;

const PATH_SWITCH = /^-(?:Literal)?(?:File)?Path$/iu;

/** PowerShell tokens: quoted strings keep their spaces, everything else splits. */
const TOKEN = /"[^"]*"|'[^']*'|\S+/gu;

function writtenPaths(command: string): readonly string[] {
  const found: string[] = [];
  for (const match of command.matchAll(WRITE_STATEMENT)) {
    const path = pathFromWriteArgs(match[1] ?? "");
    if (path !== undefined && path.length > 0)
      found.push(path.replace(/\\/gu, "/"));
  }
  return found;
}

function pathFromWriteArgs(args: string): string | undefined {
  const tokens = args.match(TOKEN) ?? [];
  for (const [index, token] of tokens.entries()) {
    if (PATH_SWITCH.test(token))
      return normalizePath(unquote(tokens[index + 1] ?? ""));
    // Only the first token can be a positional path: once a value-taking
    // switch (`-ItemType File`) is in play, the next bare word is its
    // argument, not a filename.
    if (index === 0 && !token.startsWith("-"))
      return normalizePath(unquote(token));
  }
  return undefined;
}

/**
 * Drops the `.` prefix a model habitually writes, in either separator.
 *
 * `changedFiles[].path` is read as a workspace-relative path by Herta, so
 * `./a.txt`, `.\a.txt`, and `a.txt` must not become three different files.
 * `..` is left alone — that is a real parent reference, not a prefix.
 */
function normalizePath(path: string): string {
  return path.trim().replace(/^\.[\\/]+/u, "");
}

function unquote(token: string): string {
  const first = token.at(0);
  if ((first === '"' || first === "'") && token.at(-1) === first) {
    return token.slice(1, -1);
  }
  return token;
}

/**
 * Expresses an in-workspace path the way the rest of Herta does.
 *
 * `changedFiles[].path` is compared against git's repo-relative paths and
 * narrated to the user, and the in-process backend only ever emits relative
 * ones — so a harness receipt that spells the file absolutely must not leak
 * the machine's directory layout into the report. Anything outside the
 * workspace stays absolute on purpose: a write there is worth seeing in full,
 * and `../..`-style rewrites of it would be worse than the raw path.
 */
function relativeToWorkspace(
  path: string,
  workspace: string | undefined,
): string {
  if (workspace === undefined) return path;
  const relative = relativePath(workspace, path);
  if (relative === "" || isAbsolute(relative)) return path;
  if (relative.split(/[\\/]/u)[0] === "..") return path;
  return relative.replace(/\\/gu, "/");
}

/** Recognises the test runners the report's `tests[]` is meant to carry. */
const TEST_RUNNER =
  /\b(?:pnpm|npm|yarn|bun)(?:\s+run)?\s+test\b|\bpytest\b|\bcargo\s+test\b|\bgo\s+test\b|\bvitest\b/u;

/** Collapses whitespace so a multi-line shell transcript stays one line. */
function collapse(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export interface ProjectionInput {
  readonly taskId: string;
  readonly events: readonly DshSessionEvent[];
  /** Set by the runtime when the harness failed outside a turn. */
  readonly transportError?: string;
  /**
   * The workspace the harness ran in — the only way an absolute path in a
   * shell transcript can be turned back into the relative one Herta reports.
   */
  readonly workspace?: string;
}

/**
 * Projects a completed DSH run onto the bridge contract.
 *
 * Deliberately never carries prose: `AgentExecutionReport` has no summary
 * field, and `finalResponse` is dropped here rather than forwarded, which is
 * what keeps Herta the voice of the pair instead of a re-renderer of the
 * harness's own commentary about itself.
 */
export function projectRun(input: ProjectionInput): AgentExecutionReport {
  const { events } = input;
  const { receipts, unmatchedCalls } = collectToolReceipts(events);
  const terminal = [...events]
    .reverse()
    .find((event) => event.type === "turn/end");
  const turnReason = turnReasonOf(terminal);

  const status =
    input.transportError !== undefined
      ? "failed"
      : statusFromTurnReason(turnReason);

  const evidence: EvidenceItem[] = receipts.map((receipt) => ({
    kind: receipt.name === "pwsh" ? "command" : "tool",
    summary: shellSummary(receipt),
    source: receipt.callId,
  }));

  const tests: TestRunSummary[] = [];
  for (const receipt of receipts) {
    const command = receipt.command;
    if (command === undefined || !TEST_RUNNER.test(command)) continue;
    tests.push({
      command: collapse(command),
      status: receipt.isError ? "failed" : "passed",
      summary: truncate(collapse(receipt.text), 400),
    });
  }

  const residualRisks: string[] = [];
  if (input.transportError !== undefined) {
    residualRisks.push(`DSH 传输错误：${input.transportError}`);
  }
  const errorMessage = turnReason?.error?.message;
  if (errorMessage !== undefined && errorMessage.length > 0) {
    residualRisks.push(`后端回合报错：${errorMessage}`);
  }
  for (const name of unmatchedCalls) {
    residualRisks.push(`工具 ${name} 未收到结果（回合提前结束）`);
  }

  const nextActions: string[] = [];
  if (status === "failed") {
    nextActions.push("重试该 板砖 派发，或检查模型凭证与网络");
  }
  if (
    terminal === undefined &&
    events.length > 0 &&
    input.transportError === undefined
  ) {
    // Only meaningful when the transport itself stayed up: a dead transport
    // already explains the silence, and repeating it as advice is noise.
    residualRisks.push("未观察到 turn/end 事件，本回合结论不可信");
    nextActions.push("确认 DSH 子进程是否仍存活");
  }

  const declared = declaredToolNames(events);
  if (declared.length > 0 && !declared.some((name) => name !== "pwsh")) {
    residualRisks.push(
      "DSH 仅暴露 pwsh：文件改动由 shell 文本推断，非结构化写结果",
    );
  }

  return {
    taskId: input.taskId,
    status,
    changedFiles: changedFilesFromReceipts(receipts, input.workspace),
    evidence,
    tests,
    permissions: [],
    residualRisks,
    nextActions,
  };
}

/** One receipt line: the command when we know it, else the raw output. */
function shellSummary(receipt: ToolReceipt): string {
  const body = truncate(collapse(receipt.text), 320);
  if (receipt.command === undefined) {
    return body.length > 0 ? body : `${receipt.name} (无输出)`;
  }
  const head = truncate(collapse(receipt.command), 160);
  return body.length > 0 ? `$ ${head} → ${body}` : `$ ${head}`;
}
