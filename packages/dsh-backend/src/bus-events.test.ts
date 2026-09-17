import type { AgentEvent } from "@herta/core";
import { InMemoryEventBus, summarizeShellCommand } from "@herta/core";
import { describe, expect, it } from "vitest";
import {
  DshBusTranslator,
  hertaToolName,
  summarizeHarnessInput,
} from "./bus-events.js";
import type { DshContentBlock, DshSessionEvent } from "./events.js";

const CALL_ID = "call_00_test0001";

function toolCall(
  name: string,
  command: string,
  callId: string = CALL_ID,
): DshSessionEvent {
  return {
    type: "tool/call",
    seq: 1,
    time: 1,
    data: {
      turn: 1,
      step: 1,
      callId,
      name,
      arguments: JSON.stringify({ command }),
    },
  };
}

function toolResult(
  text: string,
  options: {
    readonly callId?: string;
    readonly isError?: boolean;
    readonly includeBlock?: boolean;
  } = {},
): DshSessionEvent {
  const block: DshContentBlock = {
    type: "tool-result",
    toolCallId: options.callId ?? CALL_ID,
    content: text.length === 0 ? [] : [{ type: "text", text }],
    ...(options.isError === true ? { isError: true } : {}),
  };
  return {
    type: "tool/result",
    seq: 2,
    time: 2,
    data: {
      turn: 1,
      step: 1,
      message: {
        source: { kind: "tool", callId: options.callId ?? CALL_ID },
        content: options.includeBlock === false ? [] : [block],
      },
    },
  };
}

function collect(
  events: readonly DshSessionEvent[],
  workspaceRoot?: string,
): AgentEvent[] {
  const bus = new InMemoryEventBus<AgentEvent>();
  const seen: AgentEvent[] = [];
  bus.onAny((event) => seen.push(event));
  const translator = new DshBusTranslator({ bus, workspaceRoot });
  for (const event of events) translator.translate(event);
  return seen;
}

describe("hertaToolName", () => {
  it("maps the harness's shell tool onto the contract's bash", () => {
    // `sdk-minimal` exposes exactly one tool. Passing `pwsh` through unmapped
    // is what made every op row vanish: workflowLabel has no case for it and
    // returns null, so the bridge projected nothing and the turn read as
    // 无产出 while the harness was in fact running commands.
    expect(hertaToolName("pwsh")).toBe("bash");
  });

  it("passes unknown tools through rather than inventing a name", () => {
    // A future DSH may expose more tools. Dropping them silently is the right
    // failure — Herta's projection ignores names it has no label for — but
    // guessing a name would narrate the wrong operation.
    expect(hertaToolName("read_file")).toBe("read_file");
  });
});

describe("summarizeHarnessInput", () => {
  it("uses the shell header form, dropping the workspace-root cd", () => {
    const root = "C:/ws";
    const command = `cd "${root}" && git status --short`;
    expect(summarizeHarnessInput(JSON.stringify({ command }), root)).toBe(
      summarizeShellCommand(command, root),
    );
    expect(summarizeHarnessInput(JSON.stringify({ command }), root)).toBe(
      "git status --short",
    );
  });

  it("keeps a cd into a subdirectory, which is information", () => {
    const summary = summarizeHarnessInput(
      JSON.stringify({ command: "cd packages/core && npm test" }),
      "C:/ws",
    );
    expect(summary).toContain("packages/core");
  });

  it("takes the first line only and caps the width of an op row", () => {
    const summary = summarizeHarnessInput(
      JSON.stringify({
        command: `node -e "${"x".repeat(400)}"\r\necho second-line`,
      }),
      "C:/ws",
    );
    expect(summary).not.toContain("second-line");
    expect(summary.length).toBeLessThanOrEqual(80);
    expect(summary.endsWith("…")).toBe(true);
  });

  it("degrades to raw text on malformed arguments instead of throwing", () => {
    // Narration must never be able to take down a turn.
    expect(summarizeHarnessInput("{not json", "C:/ws")).toBe("{not json");
  });

  it("has a summary for arguments with no command field", () => {
    expect(summarizeHarnessInput(JSON.stringify({ path: "a.txt" }))).toBe(
      '{"path":"a.txt"}',
    );
    expect(summarizeHarnessInput(undefined)).toBe("");
  });
});

describe("DshBusTranslator", () => {
  it("publishes a tool.call.started the projection has a label for", () => {
    const events = collect(
      [toolCall("pwsh", 'cd "C:/ws" && git status --short')],
      "C:/ws",
    );
    expect(events).toEqual([
      {
        type: "tool.call.started",
        layer: "backend",
        id: CALL_ID,
        tool: "bash",
        inputSummary: "git status --short",
      },
    ]);
  });

  it("pairs a result with its call, which carries the tool name", () => {
    // The wire's `tool/result` names only the callId — the tool has to be
    // remembered from the `tool/call` that opened it.
    const events = collect([toolCall("pwsh", "echo hi"), toolResult("hi")]);
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({
      type: "tool.call.finished",
      id: CALL_ID,
      tool: "bash",
      result: { ok: true, summary: "hi" },
    });
  });

  it("reports a failed call in the shape the failure row reads", () => {
    const events = collect(
      [toolCall("pwsh", "exit 1"), toolResult("boom: 1", { isError: true })],
      "C:/ws",
    );
    const finished = events[1];
    expect(finished).toMatchObject({
      type: "tool.call.finished",
      result: {
        ok: false,
        summary: "boom: 1",
        error: { code: "tool_error", message: "boom: 1" },
      },
    });
  });

  it("never sends a success a tool-result payload it cannot claim", () => {
    // The projection's run_command/bash success branch wants a RunCommandData
    // it can build an exit row from, and it returns null without one. Inventing
    // `exitCode: 0` would paint a failed command green, so successes stay
    // silent and the `tool.call.started` row is the user-visible beat.
    const events = collect([toolCall("pwsh", "echo hi"), toolResult("hi")]);
    const finished = events[1] as Extract<
      AgentEvent,
      { type: "tool.call.finished" }
    >;
    expect(finished.result.data).toBeUndefined();
  });

  it("caps the summary of a real harness tool-result body", () => {
    // DSH's tool-result text is the harness's own Invoke-Expression wrapper
    // plus the output — far too much to drop into a record verbatim.
    const noise = `; $LASTEXITCODE = $null; $__s = 1; try { Invoke-Expression "${"y".repeat(3000)}"`;
    const events = collect([
      toolCall("pwsh", "echo hi", CALL_ID),
      toolResult(noise),
    ]);
    const finished = events[1] as Extract<
      AgentEvent,
      { type: "tool.call.finished" }
    >;
    expect(finished.result.summary.length).toBeLessThanOrEqual(80);
    expect(finished.result.summary.endsWith("…")).toBe(true);
  });

  it("summarises an empty result rather than emitting an empty message", () => {
    const events = collect([toolCall("pwsh", "null"), toolResult("")]);
    const finished = events[1] as Extract<
      AgentEvent,
      { type: "tool.call.finished" }
    >;
    expect(finished.result.summary).toBe("");
  });

  it("ignores a result whose call was never seen", () => {
    expect(collect([toolResult("orphan", { callId: "call_nope" })])).toEqual(
      [],
    );
  });

  it("does not leak the call-id ledger across results", () => {
    // Bounded by calls in flight: a second result for the same id has no name
    // to attach to it and is dropped.
    const events = collect([
      toolCall("pwsh", "echo hi"),
      toolResult("hi", { callId: CALL_ID }),
      toolResult("hi again", { callId: CALL_ID }),
    ]);
    expect(events.map((event) => event.type)).toEqual([
      "tool.call.started",
      "tool.call.finished",
    ]);
  });

  it("tracks overlapping calls independently", () => {
    const events = collect([
      toolCall("pwsh", "first", "call_a"),
      toolCall("pwsh", "second", "call_b"),
      toolResult("one", { callId: "call_a" }),
      toolResult("two", { callId: "call_b" }),
    ]);
    expect(
      events
        .filter((event) => event.type === "tool.call.finished")
        .map((event) => event.id),
    ).toEqual(["call_a", "call_b"]);
  });

  it("survives the wire shapes of a real captured turn", async () => {
    // The fixture is a verbatim replay of a real GUI dispatch: eight pwsh
    // calls that produced no op rows at all before this translation existed.
    const { REAL_TURN_EVENTS } = await import("./__fixtures__/real-turn.js");
    const events = collect(REAL_TURN_EVENTS, "C:/ws");
    const started = events.filter(
      (event) => event.type === "tool.call.started",
    );
    expect(started.length).toBeGreaterThan(0);
    expect(started.every((event) => event.tool === "bash")).toBe(true);
    expect(started.every((event) => event.inputSummary.length > 0)).toBe(true);
    // Every started call is answered, so nothing is left half-narrated.
    expect(
      events.filter((event) => event.type === "tool.call.finished"),
    ).toHaveLength(started.length);
  });

  it("ignores event types it has no mapping for", () => {
    const events = collect([
      { type: "turn/start", seq: 1, time: 1, data: { turn: 1 } },
      { type: "step/end", seq: 2, time: 2, data: { turn: 1, step: 1 } },
    ]);
    expect(events).toEqual([]);
  });

  it("does not throw on a tool/call missing its callId", () => {
    const events = collect([
      {
        type: "tool/call",
        seq: 1,
        time: 1,
        data: { turn: 1, step: 1, name: "pwsh", arguments: "{}" },
      },
    ]);
    expect(events).toEqual([]);
  });
});
