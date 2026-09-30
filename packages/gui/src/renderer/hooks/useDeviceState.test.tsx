import { act, renderHook, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HertaBridgeProvider } from "../context/HertaBridgeContext.js";
import {
  createMockHertaBridge,
  type MockHertaBridge,
} from "../ipc/mock-bridge.js";
import { renderWithSession } from "../testing/renderWithSession.js";
import { useDeviceState } from "./useDeviceState.js";

function setup(): { mock: MockHertaBridge; result: { current: string } } {
  const mock = createMockHertaBridge();
  const wrapper = ({ children }: { children: ReactNode }): JSX.Element => (
    <HertaBridgeProvider bridge={mock.bridge}>{children}</HertaBridgeProvider>
  );
  const { result } = renderHook(() => useDeviceState(), { wrapper });
  return { mock, result };
}

const backendStart = {
  kind: "agent" as const,
  event: {
    type: "turn.started" as const,
    layer: "backend" as const,
    userText: "",
  },
};
const backendFinish = {
  kind: "agent" as const,
  event: {
    type: "turn.finished" as const,
    layer: "backend" as const,
    summary: { durationMs: 1, toolCallCount: 0, messageCount: 0, endedAt: "" },
  },
};
/** The run's VERDICT. `turn.finished` alone only means the loop ended — a
 *  denied (blocked) or all-failed (partial) run ends the same way — so the
 *  success flash keys off this (audit 2026-07-24, 1.1). */
const backendReport = (status: string) => ({
  kind: "agent" as const,
  event: {
    type: "agent.report" as const,
    layer: "backend" as const,
    report: {
      taskId: "t",
      status,
      changedFiles: [],
      evidence: [],
      tests: [],
      permissions: [],
      residualRisks: [],
    },
  },
});
const backendFail = {
  kind: "agent" as const,
  event: {
    type: "turn.failed" as const,
    layer: "backend" as const,
    error: { kind: "tool_failed" as const, message: "x" },
  },
};

describe("useDeviceState", () => {
  afterEach(() => vi.useRealTimers());

  it("is idle with no backend activity", () => {
    const { result } = setup();
    expect(result.current).toBe("idle");
  });

  it("is delegated while the backend is active", () => {
    const { mock, result } = setup();
    act(() => mock.emitAgent(backendStart));
    expect(result.current).toBe("delegated");
  });

  it("is waitingApproval when a permission gate is pending (beats delegated)", () => {
    const { mock, result } = setup();
    act(() => mock.emitAgent(backendStart));
    act(() =>
      mock.emitOverlay({
        kind: "pending",
        overlay: {
          kind: "pending-permission",
          requestId: "r",
          risk: "workspace_write",
          tool: "write_new_file",
          summary: "x",
        },
      }),
    );
    expect(result.current).toBe("waitingApproval");
  });

  it("is failed (not succeeded) when the backend turn fails", () => {
    const { mock, result } = setup();
    act(() => mock.emitAgent(backendStart));
    act(() => mock.emitAgent(backendFail));
    expect(result.current).toBe("failed");
  });

  it("derives fine working states from the latest projected op (Slice 5)", () => {
    const { mock, result } = setup();
    act(() => mock.emitAgent(backendStart));
    expect(result.current).toBe("delegated"); // no op projected yet

    act(() =>
      mock.emitRecord({
        kind: "block",
        blockId: "b1",
        block: {
          kind: "system",
          label: "差分协处理器",
          body: "Reading src/a.ts",
          digest: { kind: "op", verb: "Reading", arg: "src/a.ts" },
        },
      }),
    );
    expect(result.current).toBe("reading");

    act(() =>
      mock.emitRecord({
        kind: "block",
        blockId: "b2",
        block: {
          kind: "system",
          label: "差分协处理器",
          body: "Writing src/a.ts",
          digest: { kind: "op", verb: "Writing", arg: "src/a.ts" },
        },
      }),
    );
    expect(result.current).toBe("writing");

    act(() =>
      mock.emitRecord({
        kind: "block",
        blockId: "b3",
        block: {
          kind: "system",
          label: "差分协处理器",
          body: "Running git status",
          digest: { kind: "op", verb: "Running", arg: "git status" },
        },
      }),
    );
    expect(result.current).toBe("runningCommand");

    act(() =>
      mock.emitRecord({
        kind: "block",
        blockId: "b4",
        block: {
          kind: "system",
          label: "差分协处理器",
          body: "Running pnpm test",
          digest: { kind: "op", verb: "Running", arg: "pnpm test" },
        },
      }),
    );
    expect(result.current).toBe("verifying");
  });

  it("a done-marker bounds the walk: the next run starts coarse, not with a stale verb", () => {
    const { mock, result } = setup();
    // Run 1: an op, then its terminal marker, then a clean finish.
    act(() => mock.emitAgent(backendStart));
    act(() =>
      mock.emitRecord({
        kind: "block",
        blockId: "b1",
        block: {
          kind: "system",
          label: "差分协处理器",
          body: "Writing src/a.ts",
          digest: { kind: "op", verb: "Writing", arg: "src/a.ts" },
        },
      }),
    );
    act(() =>
      mock.emitRecord({
        kind: "block",
        blockId: "b2",
        block: {
          kind: "system",
          label: "差分协处理器",
          body: "完成 · 1 file",
          role: "done-marker",
        },
      }),
    );
    act(() => mock.emitAgent(backendFinish));
    // Run 2: active again but no op projected yet — the finished run's
    // Writing must not bleed through the marker.
    act(() => mock.emitAgent(backendStart));
    expect(result.current).toBe("delegated");
  });

  it("waitingApproval still beats a fine working state", () => {
    const { mock, result } = setup();
    act(() => mock.emitAgent(backendStart));
    act(() =>
      mock.emitRecord({
        kind: "block",
        blockId: "b1",
        block: {
          kind: "system",
          label: "差分协处理器",
          body: "Writing src/a.ts",
          digest: { kind: "op", verb: "Writing", arg: "src/a.ts" },
        },
      }),
    );
    expect(result.current).toBe("writing");
    act(() =>
      mock.emitOverlay({
        kind: "pending",
        overlay: {
          kind: "pending-permission",
          requestId: "r",
          risk: "workspace_write",
          tool: "write_new_file",
          summary: "x",
        },
      }),
    );
    expect(result.current).toBe("waitingApproval");
  });

  it("flashes succeeded on a clean finish, then settles to idle", () => {
    vi.useFakeTimers();
    const { mock, result } = setup();
    act(() => mock.emitAgent(backendStart));
    expect(result.current).toBe("delegated");
    act(() => mock.emitAgent(backendFinish));
    act(() => mock.emitAgent(backendReport("completed") as never));
    expect(result.current).toBe("succeeded");
    // Still flashing partway through the (longer, 1800ms) window.
    act(() => vi.advanceTimersByTime(900));
    expect(result.current).toBe("succeeded");
    // Settles to idle once the full window elapses.
    act(() => vi.advanceTimersByTime(1100));
    expect(result.current).toBe("idle");
  });
});

describe("useDeviceState — lifecycle boundaries (audit 2026-07-24)", () => {
  afterEach(() => vi.useRealTimers());

  function Probe(): JSX.Element {
    return <span data-testid="state">{useDeviceState()}</span>;
  }
  const stateOf = (): string | null => screen.getByTestId("state").textContent;

  it("the success flash does NOT follow a session switch (M7)", () => {
    vi.useFakeTimers();
    const h = renderWithSession(<Probe />);
    h.startBackend();
    expect(stateOf()).toBe("delegated");
    h.finishBackend();
    expect(stateOf()).toBe("succeeded");
    // Switch while the ~1.8s flash is still armed. Pre-fix the leftover timer
    // painted the NEXT session's card green with a 完成 / Done label over an
    // empty transcript, then dropped to idle like a glitch.
    h.switchSession();
    expect(stateOf()).toBe("idle");
    act(() => vi.advanceTimersByTime(5000));
    expect(stateOf()).toBe("idle");
  });

  it("the flash does not follow a delete-blanking either", () => {
    vi.useFakeTimers();
    const h = renderWithSession(<Probe />);
    h.startBackend();
    h.finishBackend();
    expect(stateOf()).toBe("succeeded");
    h.deleteSession();
    expect(stateOf()).toBe("idle");
  });

  it("an INTERRUPTED backend run does not leave the card red (M2)", () => {
    const h = renderWithSession(<Probe />);
    h.startBackend();
    expect(stateOf()).toBe("delegated");
    h.failBackend("interrupted");
    expect(stateOf()).toBe("idle");
  });

  it("a DENIED run does not flash green (audit 2026-07-24, 1.1)", () => {
    // `turn.finished` fires for a blocked run too — the loop ended without
    // throwing. Counting that as success flashed 完成 / Done while the
    // activity line beside it said 受阻 / Blocked, about the same run.
    vi.useFakeTimers();
    const h = renderWithSession(<Probe />);
    h.startBackend();
    h.finishBackend("blocked");
    expect(stateOf()).toBe("idle");
    act(() => vi.advanceTimersByTime(2000));
    expect(stateOf()).toBe("idle");
  });

  it("an all-failed (partial) run does not flash green either", () => {
    vi.useFakeTimers();
    const h = renderWithSession(<Probe />);
    h.startBackend();
    h.finishBackend("partial");
    expect(stateOf()).toBe("idle");
  });

  it("a genuine backend failure still reports failed", () => {
    const h = renderWithSession(<Probe />);
    h.startBackend();
    h.failBackend("tool_failed");
    expect(stateOf()).toBe("failed");
  });

  it("a stale active-edge from the previous session cannot fabricate a flash", () => {
    vi.useFakeTimers();
    const h = renderWithSession(<Probe />);
    // Leave session A mid-run (backendActive true, no finish edge yet).
    h.startBackend();
    expect(stateOf()).toBe("delegated");
    h.switchSession();
    // B starts idle; the store's reset cleared backendActive. With the edge
    // baseline unscoped, B's first idle render read wasActive=true and fired
    // a success flash for a run that never happened here.
    expect(stateOf()).toBe("idle");
    act(() => vi.advanceTimersByTime(2000));
    expect(stateOf()).toBe("idle");
  });
});
