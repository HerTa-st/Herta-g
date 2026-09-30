import type { AgentEvent, SessionAgentEvent } from "@herta/app-server";
import { describe, expect, it } from "vitest";
import { slimAgentEventForRenderer } from "./agent-event-wire.js";

const wrap = (event: AgentEvent): SessionAgentEvent => ({
  kind: "agent",
  event,
});
const BIG = "x".repeat(2_000_000);

describe("slimAgentEventForRenderer", () => {
  it("drops what the renderer never reads: 板砖's tokens, whole messages, previews, approvals, progress", () => {
    const dropped: AgentEvent[] = [
      { type: "assistant.delta", layer: "backend", text: "tok" },
      {
        type: "assistant.final",
        layer: "backend",
        message: {
          role: "assistant",
          text: BIG,
          toolCalls: [],
          ts: "",
        },
      },
      {
        type: "assistant.final",
        layer: "actor",
        message: { role: "assistant", text: "hi", toolCalls: [], ts: "" },
      },
      { type: "tool.call.progress", layer: "backend", id: "c", message: BIG },
      {
        type: "permission.requested",
        layer: "backend",
        request: {
          id: "p",
          call: { id: "c", tool: "bash", input: { command: BIG } },
          reason: "r",
          risk: "workspace_write",
          diff: BIG,
        },
      },
      {
        type: "permission.resolved",
        layer: "backend",
        id: "p",
        decision: "allow",
      },
      { type: "patch.preview", layer: "backend", diff: BIG, files: ["a.ts"] },
      { type: "verification.started", layer: "backend", command: "pnpm test" },
      {
        type: "verification.finished",
        layer: "backend",
        result: { passed: true },
      },
      { type: "user.steer", layer: "actor", id: "steer:1", text: "also b.txt" },
      // The live views ride their own folded, throttled channel (ADR 0073).
      {
        type: "tool.call.delta",
        layer: "backend",
        id: "c",
        tool: "str_replace_editor",
        argsDelta: BIG,
      },
      { type: "tool.call.output", layer: "backend", id: "c", chunk: BIG },
    ];
    for (const ev of dropped) {
      expect(slimAgentEventForRenderer(wrap(ev)), ev.type).toBeNull();
    }
  });

  it("passes Herta's own deltas and the small lifecycle signals through untouched", () => {
    const kept: AgentEvent[] = [
      { type: "assistant.delta", layer: "actor", text: "嗯" },
      {
        type: "turn.finished",
        layer: "backend",
        summary: {
          durationMs: 1,
          toolCallCount: 2,
          messageCount: 3,
          endedAt: "",
        },
      },
      {
        type: "turn.failed",
        layer: "backend",
        error: { kind: "interrupted", message: "stopped" },
      },
      { type: "recap.compaction", layer: "actor", phase: "start" },
      { type: "supervisor.check", layer: "actor", phase: "end" },
      {
        type: "tool.call.started",
        layer: "backend",
        id: "c",
        tool: "bash",
        inputSummary: "ls",
      },
    ];
    for (const ev of kept) {
      const wired = wrap(ev);
      expect(slimAgentEventForRenderer(wired), ev.type).toBe(wired);
    }
    const dropNotice: SessionAgentEvent = { kind: "dropped", count: 3 };
    expect(slimAgentEventForRenderer(dropNotice)).toBe(dropNotice);
  });

  it("keeps the fields the store branches on and empties the payload beside them", () => {
    const finished = slimAgentEventForRenderer(
      wrap({
        type: "tool.call.finished",
        layer: "backend",
        id: "c1",
        tool: "view_image",
        result: {
          ok: true,
          summary: "viewed a.png",
          data: { text: BIG },
          modelText: BIG,
          images: [{ dataUri: `data:image/png;base64,${BIG}`, path: "a.png" }],
        },
      }),
    );
    expect(finished).toEqual({
      kind: "agent",
      event: {
        type: "tool.call.finished",
        layer: "backend",
        id: "c1",
        tool: "view_image",
        result: { ok: true, summary: "viewed a.png" },
      },
    });

    const started = slimAgentEventForRenderer(
      wrap({ type: "turn.started", layer: "backend", userText: BIG }),
    );
    expect(started).toEqual({
      kind: "agent",
      event: { type: "turn.started", layer: "backend", userText: "" },
    });

    const report = slimAgentEventForRenderer(
      wrap({
        type: "agent.report",
        layer: "backend",
        report: {
          taskId: "t1",
          status: "completed",
          changedFiles: [],
          evidence: [{ kind: "finding", text: BIG } as never],
          tests: [],
          permissions: [],
          residualRisks: [BIG],
        },
      }),
    );
    expect(report).toEqual({
      kind: "agent",
      event: {
        type: "agent.report",
        layer: "backend",
        report: {
          taskId: "t1",
          status: "completed",
          changedFiles: [],
          evidence: [],
          tests: [],
          permissions: [],
          residualRisks: [],
        },
      },
    });
    // Nothing heavy survives any of them.
    for (const e of [finished, started, report]) {
      expect(JSON.stringify(e).length).toBeLessThan(400);
    }
  });
});
