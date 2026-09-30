import type { AgentEvent } from "@herta/app-server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { slimAgentEventForRenderer } from "../../shared/agent-event-wire.js";
import { createMockHertaBridge } from "../ipc/mock-bridge.js";
import { SessionStore } from "./session-store.js";

// The main process forwards the agent stream SLIMMED (shared/agent-event-wire.ts):
// events this store ignores are not sent, heavy fields are emptied. The
// claim that makes that safe is "the store cannot tell" — pinned here by
// running one whole turn through two stores, raw and slimmed, and comparing
// the snapshot after every event.
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-20T00:00:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
});

const BIG = "x".repeat(200_000);

const TURN: AgentEvent[] = [
  { type: "turn.started", layer: "actor", userText: "fix it @板砖" },
  { type: "supervisor.check", layer: "actor", phase: "start" },
  { type: "assistant.delta", layer: "actor", text: "嗯，" },
  { type: "assistant.delta", layer: "actor", text: "交给板砖。" },
  { type: "supervisor.check", layer: "actor", phase: "end" },
  {
    type: "assistant.final",
    layer: "actor",
    message: {
      role: "assistant",
      text: "嗯，交给板砖。",
      toolCalls: [],
      ts: "",
    },
  },
  { type: "turn.started", layer: "backend", userText: BIG },
  { type: "assistant.delta", layer: "backend", text: "thinking" },
  {
    type: "assistant.final",
    layer: "backend",
    message: { role: "assistant", text: BIG, toolCalls: [], ts: "" },
  },
  {
    type: "tool.call.started",
    layer: "backend",
    id: "a",
    tool: "bash",
    inputSummary: "cat a.ts",
  },
  {
    type: "tool.call.started",
    layer: "backend",
    id: "b",
    tool: "view_image",
    inputSummary: "a.png",
  },
  { type: "tool.call.progress", layer: "backend", id: "a", message: "…" },
  {
    type: "tool.call.finished",
    layer: "backend",
    id: "a",
    tool: "bash",
    result: { ok: true, summary: "ran", modelText: BIG, data: { out: BIG } },
  },
  { type: "patch.preview", layer: "backend", diff: BIG, files: ["a.ts"] },
  {
    type: "permission.resolved",
    layer: "backend",
    id: "b",
    decision: "blocked",
    tool: "view_image",
  },
  {
    type: "tool.call.finished",
    layer: "backend",
    id: "b",
    tool: "view_image",
    result: {
      ok: false,
      summary: "failed: permission_denied",
      error: { code: "permission_denied", message: "no", retryable: false },
    },
  },
  {
    type: "tool.call.delta",
    layer: "backend",
    id: "c",
    tool: "str_replace_editor",
    argsDelta: BIG,
  },
  { type: "tool.call.output", layer: "backend", id: "c", chunk: BIG },
  { type: "user.steer", layer: "actor", id: "steer:1", text: "also b.ts" },
  { type: "verification.started", layer: "backend", command: "pnpm test" },
  { type: "verification.finished", layer: "backend", result: { passed: true } },
  {
    type: "agent.report",
    layer: "backend",
    report: {
      taskId: "t",
      status: "completed",
      changedFiles: [],
      evidence: [],
      tests: [],
      permissions: [],
      residualRisks: [BIG],
    },
  },
  {
    type: "turn.finished",
    layer: "backend",
    summary: { durationMs: 1, toolCallCount: 2, messageCount: 3, endedAt: "" },
  },
  { type: "recap.compaction", layer: "actor", phase: "start" },
  { type: "recap.compaction", layer: "actor", phase: "end" },
  {
    type: "turn.failed",
    layer: "backend",
    error: { kind: "provider_failed", message: "boom" },
  },
];

describe("SessionStore over the slimmed agent wire", () => {
  it("reaches the same snapshot, event by event, as over the raw stream — while far less crosses", () => {
    const raw = { mock: createMockHertaBridge(), store: new SessionStore() };
    const slim = { mock: createMockHertaBridge(), store: new SessionStore() };
    raw.store.connect(raw.mock.bridge);
    slim.store.connect(slim.mock.bridge);
    // Deltas only land inside a turn.
    raw.mock.emitTurn({ kind: "started", turnId: "t1" });
    slim.mock.emitTurn({ kind: "started", turnId: "t1" });

    let rawBytes = 0;
    let slimBytes = 0;
    let sent = 0;
    for (const event of TURN) {
      const wired = { kind: "agent" as const, event };
      raw.mock.emitAgent(wired);
      rawBytes += JSON.stringify(wired).length;
      const slimmed = slimAgentEventForRenderer(wired);
      if (slimmed !== null) {
        slim.mock.emitAgent(slimmed);
        slimBytes += JSON.stringify(slimmed).length;
        sent += 1;
      }
      expect(slim.store.getSnapshot(), event.type).toEqual(
        raw.store.getSnapshot(),
      );
    }
    // The run really moved the store (anti-vacuous)…
    const end = raw.store.getSnapshot();
    expect(end.streamingText).toBe("嗯，交给板砖。");
    expect(end.backendSucceededSeq).toBe(1);
    expect(end.backendError).toBe(true);
    // …and the wire carried a sliver of it.
    expect(sent).toBeLessThan(TURN.length);
    expect(rawBytes).toBeGreaterThan(1_000_000);
    expect(slimBytes).toBeLessThan(3_000);
    raw.store.dispose();
    slim.store.dispose();
  });
});
