import type { AgentEvent, EventBus, ToolResult } from "@herta/core";
import { summarizeShellCommand } from "@herta/core";
import type { DshContentBlock, DshSessionEvent } from "./events.js";

/**
 * Republishing a harness turn onto Herta's own bus.
 *
 * The bridge (packages/herta/src/narrative/backend-bridge.ts) learns what the
 * backend did by draining the session bus, not by reading the returned
 * `AgentExecutionReport` — the report only decides the terminal marker, while
 * every `→ 差分协处理器` operation row comes from a bus event. The in-process
 * `CodingAgentRuntime` publishes those itself. An out-of-process harness
 * cannot: its work arrives as JSON-RPC notifications, so unless something
 * translates them the bridge drains an empty bus, `projectedAny` stays false
 * for the whole dispatch, and a turn that ran eight commands renders as
 * `差分协处理器 无产出` — the harness runs fine and the record says it did
 * nothing.
 *
 * This module is that translation, and only that: DSH wire shapes in, Herta's
 * `AgentEvent` out. It holds no state beyond one dispatch's call ids.
 */

/**
 * DSH tool name → the Herta tool name the narrative layer already narrates.
 *
 * `sdk-minimal` exposes exactly one tool, `pwsh`, and it is the same KIND of
 * tool as the minimal contract's `bash` (ADR 0040): a shell whose model-facing
 * output is plain text and whose single argument is `{command}`. Mapping it
 * onto that name is what lets the existing projection and summariser handle a
 * harness turn with no new cases, and it keeps DSH's vocabulary from leaking
 * into Herta's narrative layer — `workflowLabel`'s `default: null` is what
 * silently dropped every one of those calls.
 */
const TOOL_ALIASES: Readonly<Record<string, string>> = { pwsh: "bash" };

/** Matches `summarizeInput`'s cap, so a harness row reads like a Herta one. */
const SUMMARY_CAP = 80;

/** The name Herta's projection knows for a DSH tool; unmapped names pass through. */
export function hertaToolName(dshTool: string): string {
  return TOOL_ALIASES[dshTool] ?? dshTool;
}

/**
 * The `inputSummary` for an op row, from the call's JSON-encoded arguments.
 *
 * A shell call gets `summarizeShellCommand` — the same header form Herta's own
 * `bash` rows use, so a `cd <workspace> && …` prefix is dropped and the row
 * says what is actually being run. Anything else is capped raw JSON, which is
 * what `summarizeInput` falls back to as well.
 */
export function summarizeHarnessInput(
  rawArguments: string | undefined,
  workspaceRoot?: string,
): string {
  const toSummary = (text: string): string => {
    const oneLine = text.replace(/\s+/g, " ").trim();
    return oneLine.length > SUMMARY_CAP
      ? `${oneLine.slice(0, SUMMARY_CAP - 1)}…`
      : oneLine;
  };
  if (rawArguments === undefined) return "";
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawArguments);
  } catch {
    // A malformed blob must degrade to the raw text rather than throw: the
    // op row is narration, not a correctness surface.
    return toSummary(rawArguments);
  }
  if (typeof parsed === "object" && parsed !== null) {
    const command = (parsed as { command?: unknown }).command;
    if (typeof command === "string" && command.length > 0) {
      return toSummary(summarizeShellCommand(command, workspaceRoot));
    }
  }
  try {
    return toSummary(JSON.stringify(parsed) ?? "");
  } catch {
    return "";
  }
}

/** The `tool-result` block of a `tool/result`, when there is one. */
function toolResultOf(event: DshSessionEvent): {
  readonly callId: string | undefined;
  readonly isError: boolean;
  readonly text: string;
} {
  const callId = event.data?.message?.source?.callId;
  const block = event.data?.message?.content?.find(
    (
      candidate,
    ): candidate is Extract<DshContentBlock, { type: "tool-result" }> =>
      candidate.type === "tool-result",
  );
  if (block === undefined) return { callId, isError: false, text: "" };
  const text = (block.content ?? [])
    .map((part) => (part.type === "text" ? part.text : ""))
    .filter((part) => part.length > 0)
    .join("\n");
  return { callId, isError: block.isError === true, text };
}

/**
 * The receipt Herta's failure row reads.
 *
 * Only `ok`/`summary`/`error` are set. No `data`: Herta's `run_command` result
 * projection expects a `RunCommandData` it can render an exit row from, and
 * DSH's `tool/result` carries the harness's own `Invoke-Expression` wrapper
 * text rather than a structured exit code — inventing `exitCode: 0` would
 * turn a failed command into a green row. The op row published on `tool/call`
 * is the user-visible beat; this one exists so a FAILED call still surfaces.
 */
function receiptOf(text: string, isError: boolean): ToolResult {
  const firstLine = (
    text.split(/\r?\n/).find((line) => line.trim() !== "") ?? ""
  ).trim();
  const summary =
    firstLine.length > SUMMARY_CAP
      ? `${firstLine.slice(0, SUMMARY_CAP - 1)}…`
      : firstLine;
  if (!isError) return { ok: true, summary };
  return {
    ok: false,
    summary,
    error: {
      // DSH reports failure as `isError` with no machine code, so this names
      // the class ("the harness's tool call failed") rather than a cause.
      code: "tool_error",
      message: summary.length > 0 ? summary : "(no output)",
      retryable: false,
    },
  };
}

/**
 * One dispatch's worth of translation. Stateful only in the call-id ledger:
 * `tool/result` does not carry the tool's name, so the name has to be
 * remembered from the `tool/call` that opened it. Entries are dropped when
 * their result arrives, which keeps the ledger bounded by the number of calls
 * in flight.
 */
export class DshBusTranslator {
  private readonly bus: EventBus<AgentEvent>;
  private readonly workspaceRoot: string | undefined;
  private readonly open = new Map<string, string>();

  constructor(options: {
    readonly bus: EventBus<AgentEvent>;
    readonly workspaceRoot?: string;
  }) {
    this.bus = options.bus;
    this.workspaceRoot = options.workspaceRoot;
  }

  /**
   * Publishes the Herta events this harness notification implies — zero, one,
   * or (never, today) more. Unrecognised event types are ignored: DSH's schema
   * is a separately-versioned product's, and an event this package does not
   * know must not throw inside the notification handler.
   */
  translate(event: DshSessionEvent): void {
    if (event.type === "tool/call") {
      const callId = event.data?.callId;
      const name = event.data?.name;
      if (callId === undefined || name === undefined) return;
      const tool = hertaToolName(name);
      const inputSummary = summarizeHarnessInput(
        event.data?.arguments,
        this.workspaceRoot,
      );
      this.open.set(callId, tool);
      this.bus.publish({
        type: "tool.call.started",
        layer: "backend",
        id: callId,
        tool,
        inputSummary,
      });
      return;
    }

    if (event.type === "tool/result") {
      const { callId, isError, text } = toolResultOf(event);
      if (callId === undefined) return;
      // A result with no matching call is not narration we can attribute;
      // dropping it beats inventing a tool name for the row.
      const tool = this.open.get(callId);
      if (tool === undefined) return;
      this.open.delete(callId);
      this.bus.publish({
        type: "tool.call.finished",
        layer: "backend",
        id: callId,
        tool,
        result: receiptOf(text, isError),
      });
    }
  }
}
