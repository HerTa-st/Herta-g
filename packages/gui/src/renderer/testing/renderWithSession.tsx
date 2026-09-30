import { act, type RenderResult, render } from "@testing-library/react";
import type { ReactNode } from "react";
import { HertaBridgeProvider } from "../context/HertaBridgeContext.js";
import { LocaleProvider } from "../i18n/LocaleProvider.js";
import type { Locale } from "../ipc/bridge-types.js";
import {
  createMockHertaBridge,
  type MockHertaBridge,
} from "../ipc/mock-bridge.js";

/**
 * Render a component inside a LIVE session and drive it across LIFECYCLE
 * BOUNDARIES (audit 2026-07-24, Gap 4).
 *
 * Why: every transient-state bug in that audit lived at a boundary — a
 * session switch, a delete-blanking, an interrupt, a failed turn — and NO
 * test crossed one with a transient in flight. Component suites mounted a
 * component and asserted a steady state; the store suite drove events but
 * rendered nothing. The bugs lived in the gap between.
 *
 * ```ts
 * const h = renderWithSession(<DeviceCard />);
 * h.finishBackend();          // arms the 1.8s success flash
 * h.switchSession("other");   // ← the boundary
 * expect(...).toBe("idle");   // the flash must not follow
 * ```
 *
 * Every helper is wrapped in `act`, so state settles before the assertion.
 */
export interface SessionHarness extends RenderResult {
  readonly mock: MockHertaBridge;
  /** The session id currently activated by the harness (null after a blanking). */
  sessionId(): string | null;
  /** Activate a session (the `reset` snapshot main sends on open/switch). */
  openSession(id?: string): void;
  /** Switch to a DIFFERENT session — the most common boundary. */
  switchSession(id?: string): void;
  /** Delete a session. Defaults to the OPEN one, which also blanks to the
   *  connect screen (the delete-blanking boundary the pill bug lived at). */
  deleteSession(id?: string): void;
  /** Blank to the connect screen without deleting (main's no-session reset). */
  blank(): void;
  /** Start an actor turn. */
  startTurn(turnId?: string): void;
  /** Finish an actor turn cleanly. */
  finishTurn(turnId?: string): void;
  /** Fail an actor turn. `kind: "interrupt"` sends the AbortError code the
   *  user's stop button produces; "provider" sends a genuine failure. */
  failTurn(kind?: "interrupt" | "provider", status?: number): void;
  /** Start a @板砖 backend run (backend-layer turn.started). */
  startBackend(): void;
  /** Finish the backend run. Emits BOTH the lifecycle end and the run's
   *  verdict (`agent.report`) — the flash keys off the verdict, since
   *  `turn.finished` alone is equally true of a denied or all-failed run
   *  (audit 2026-07-24, 1.1). Pass a status to model those endings. */
  finishBackend(status?: "completed" | "blocked" | "partial"): void;
  /** Fail the backend run. `interrupted` is the user's stop button; anything
   *  else is a genuine error. */
  failBackend(kind?: "interrupted" | "tool_failed"): void;
}

let seq = 0;

export function renderWithSession(
  ui: ReactNode,
  opts: { locale?: Locale; sessionId?: string; mock?: MockHertaBridge } = {},
): SessionHarness {
  const mock = opts.mock ?? createMockHertaBridge();
  const locale = opts.locale ?? "en";
  let current: string | null = null;

  function Wrapper({ children }: { children: ReactNode }): JSX.Element {
    return (
      <HertaBridgeProvider bridge={mock.bridge}>
        <LocaleProvider locale={locale} onLocaleChange={() => {}}>
          {children}
        </LocaleProvider>
      </HertaBridgeProvider>
    );
  }
  const result = render(ui, { wrapper: Wrapper });

  const openSession = (id?: string): void => {
    seq += 1;
    const sid = id ?? `session-${seq}`;
    current = sid;
    act(() => {
      mock.emitReset({
        sessionId: sid,
        workspaceRoot: "/r",
        record: [],
        overlay: null,
        backendWorkspace: "/r",
        backendWorkspaceIsDefault: true,
      });
    });
  };

  const harness: SessionHarness = {
    ...result,
    mock,
    sessionId: () => current,
    openSession,
    switchSession: (id) => openSession(id),
    deleteSession: (id) => {
      const target = id ?? current;
      act(() => {
        if (target !== null) mock.emitSessionDeleted({ sessionId: target });
      });
      // Deleting the OPEN session blanks to the connect screen; deleting any
      // other one leaves the active session alone.
      if (target === current) harness.blank();
    },
    blank: () => {
      current = null;
      act(() => {
        mock.emitReset({ noSession: true });
      });
    },
    startTurn: (turnId = "t1") => {
      act(() => {
        mock.emitTurn({ kind: "started", turnId });
      });
    },
    finishTurn: (turnId = "t1") => {
      act(() => {
        mock.emitTurn({ kind: "finished", turnId });
      });
    },
    failTurn: (kind = "provider", status) => {
      act(() => {
        mock.emitTurn({
          kind: "failed",
          turnId: "t1",
          error:
            kind === "interrupt"
              ? { code: "AbortError", message: "aborted" }
              : {
                  code: "provider_error",
                  message: "boom",
                  ...(status === undefined ? {} : { status }),
                },
        });
      });
    },
    startBackend: () => {
      act(() => {
        mock.emitAgent({
          kind: "agent",
          event: {
            type: "turn.started",
            layer: "backend",
            userText: "",
          } as never,
        });
      });
    },
    finishBackend: (status = "completed") => {
      act(() => {
        mock.emitAgent({
          kind: "agent",
          event: {
            type: "turn.finished",
            layer: "backend",
            summary: {
              durationMs: 1,
              toolCallCount: 0,
              messageCount: 0,
              endedAt: "",
            },
          } as never,
        });
        mock.emitAgent({
          kind: "agent",
          event: {
            type: "agent.report",
            layer: "backend",
            report: {
              taskId: "t",
              status,
              changedFiles: [],
              evidence: [],
              tests: [],
              permissions: [],
              residualRisks: [],
            },
          } as never,
        });
      });
    },
    failBackend: (kind = "tool_failed") => {
      act(() => {
        mock.emitAgent({
          kind: "agent",
          event: {
            type: "turn.failed",
            layer: "backend",
            error: { kind, message: "x" },
          } as never,
        });
      });
    },
  };

  openSession(opts.sessionId);
  return harness;
}
