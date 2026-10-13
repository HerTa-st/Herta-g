import type { TerminalRecord } from "@herta/app-server";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./App.js";
import { createMockHertaBridge } from "./ipc/mock-bridge.js";
import { type Census, startRenderCensus } from "./test-utils/render-census.js";

/**
 * Render ratchets (2026-09-24): how many components React re-renders for
 * the two things a user does most — type a character, and watch a reply
 * stream in. Counts, not clocks (test-utils/render-census.ts), so they are
 * exact under fake timers and can hold a line in the test gate.
 *
 * A ratchet only turns one way. A count ABOVE its ceiling fails: something
 * now re-renders on every keystroke or every glyph that did not before —
 * find it in the census the failure prints, or raise the ceiling in the same
 * commit that makes the extra renders deliberate, and say why. A count
 * BELOW its ceiling fails too, asking to lower it: the win is locked in the
 * moment it lands, instead of drifting back unnoticed.
 *
 * Method from the claude.ai speed-up (2026-09-23 post): measure a
 * deterministic count, drive it down, ratchet it.
 */

/** One keystroke in the composer: the composer, its send glyph, the send
 *  tooltip and the composer's wave — nothing outside the composer. */
const KEYSTROKE_RENDERS = 4;
/** Five streamed glyphs of Herta's reply (timers advanced between them). */
const FIVE_DELTAS_RENDERS = 35;

vi.mock("./components/Opening/pick-opening-segment.js", () => ({
  // The splash never loads a segment in jsdom (see App.test.tsx).
  pickOpeningSegment: () => () => new Promise<never>(() => {}),
}));

afterEach(() => {
  vi.useRealTimers();
});

function history(n: number): TerminalRecord {
  const out: TerminalRecord[number][] = [];
  for (let i = 0; i < n; i += 1) {
    out.push(
      i % 2 === 0
        ? { kind: "user", text: `Message ${i}: what the user asked.` }
        : {
            kind: "herta",
            surface: "speech",
            text: `Reply ${i}: Herta's answer, long enough to wrap onto a second line in the bubble.`,
          },
    );
  }
  return out;
}

/** The whole app, a session open with `blocks` of history, entrance settled. */
function openApp(blocks: number): ReturnType<typeof createMockHertaBridge> {
  vi.useFakeTimers();
  const mock = createMockHertaBridge();
  render(<App bridge={mock.bridge} />);
  act(() => {
    mock.emitReset({
      sessionId: "s",
      workspaceRoot: "/r",
      record: history(blocks),
      overlay: null,
      backendWorkspace: "/r",
      backendWorkspaceIsDefault: true,
      // The pane reads in the session's language; this one matches the UI.
      lang: "en",
    });
  });
  act(() => {
    vi.advanceTimersByTime(5000);
  });
  return mock;
}

function describeCensus(c: Census): string {
  return `${c.renders} renders in ${c.commits} commit(s): ${c.byComponent
    .map(([name, n]) => `${name}×${n}`)
    .join(", ")}`;
}

/** Fails above the ceiling (a regression) and below it (lock the win in). */
function ratchet(what: string, c: Census, ceiling: number): void {
  if (c.renders > ceiling) {
    throw new Error(
      `${what} now costs ${describeCensus(c)} — ceiling ${ceiling}. Find the new renders above, or raise the ceiling in render-ratchet.test.tsx with the reason.`,
    );
  }
  if (c.renders < ceiling) {
    throw new Error(
      `${what} improved to ${c.renders} renders (ceiling ${ceiling}) — lower the ceiling in render-ratchet.test.tsx to ${c.renders} to lock it in. ${describeCensus(c)}`,
    );
  }
}

function streamFiveDeltas(blocks: number): Census {
  const mock = openApp(blocks);
  const delta = (text: string): void =>
    mock.emitAgent({
      kind: "agent",
      event: { type: "assistant.delta", layer: "actor", text } as never,
    });
  act(() => {
    mock.emitTurn({ kind: "started", turnId: "t1" });
  });
  act(() => {
    vi.advanceTimersByTime(1000);
  });
  // The first glyph flips the turn into speaking (the bubble mounts) — a
  // one-off; the census counts the steady stream after it.
  act(() => delta("嗯"));
  act(() => {
    vi.advanceTimersByTime(200);
  });
  const census = startRenderCensus();
  for (let i = 0; i < 5; i += 1) {
    act(() => delta("字"));
    act(() => {
      vi.advanceTimersByTime(80);
    });
  }
  return census.stop();
}

describe("render ratchets", () => {
  it("a keystroke re-renders only the composer", () => {
    openApp(10);
    const input = screen.getByPlaceholderText("Message Herta…");
    // The first character (empty → text: the send button wakes) and a later
    // one: the two keystrokes a user makes most.
    for (const value of ["a", "ab"]) {
      const census = startRenderCensus();
      act(() => {
        fireEvent.change(input, { target: { value } });
      });
      act(() => {
        vi.advanceTimersByTime(1000);
      });
      ratchet(`typing "${value}"`, census.stop(), KEYSTROKE_RENDERS);
    }
  });

  it("a streamed glyph costs the same with 10 or 100 blocks of history", () => {
    const short = streamFiveDeltas(10);
    ratchet("five streamed glyphs", short, FIVE_DELTAS_RENDERS);
    // The history behind the reply must not re-render per glyph: the memo
    // chain (gui-streaming-render-map) keeps the stream O(1) in its length.
    const long = streamFiveDeltas(100);
    expect(describeCensus(long)).toBe(describeCensus(short));
  });

  it("the census sees a render it is shown (not vacuous)", () => {
    openApp(10);
    const census = startRenderCensus();
    // Toggling the sidebar re-renders the app root, far past the composer.
    act(() => {
      fireEvent.click(screen.getByLabelText("Toggle sidebar"));
    });
    const c = census.stop();
    expect(c.commits).toBeGreaterThan(0);
    expect(c.renders).toBeGreaterThan(KEYSTROKE_RENDERS);
    expect(c.byComponent.map(([name]) => name)).toContain("Sidebar");
  });
});
