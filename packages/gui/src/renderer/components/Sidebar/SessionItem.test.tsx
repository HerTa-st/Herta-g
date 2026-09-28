import { act, fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { HertaBridgeProvider } from "../../context/HertaBridgeContext.js";
import { useSessionSelector } from "../../hooks/useSessionSelector.js";
import { renderWithLocale } from "../../i18n/test-util.js";
import {
  createMockHertaBridge,
  type MockHertaBridge,
} from "../../ipc/mock-bridge.js";
import { mockSessionList } from "../../mocks/sessions.js";
import { SessionItem } from "./SessionItem.js";

const SESSION = mockSessionList[0] ?? {
  sessionId: "today-1",
  workspaceRoot: "/repo",
  startedAt: "",
  lastActivityAt: "",
};

function setup(activeId: string): MockHertaBridge {
  const mock = createMockHertaBridge();
  renderWithLocale(
    <HertaBridgeProvider bridge={mock.bridge}>
      <SessionItem session={SESSION} title="Test session" />
    </HertaBridgeProvider>,
  );
  act(() => {
    mock.emitReset({
      sessionId: activeId,
      workspaceRoot: "/repo",
      record: [],
      overlay: null,
      backendWorkspace: "/r",
      backendWorkspaceIsDefault: true,
    });
  });
  return mock;
}

function emitPending(mock: MockHertaBridge): void {
  act(() => {
    mock.emitOverlay({
      kind: "pending",
      overlay: {
        kind: "pending-permission",
        requestId: "r1",
        risk: "workspace_write",
        tool: "write_new_file",
        summary: "x",
      },
    });
  });
}

describe("SessionItem open guards", () => {
  it("clicking a NON-active row opens it", () => {
    const mock = setup("some-other-session");
    fireEvent.click(screen.getByTestId("session-card"));
    expect(mock.calls.openSession).toEqual([SESSION.sessionId]);
  });

  it("clicking the ALREADY-ACTIVE row is a no-op (re-open desyncs a running turn)", () => {
    const mock = setup(SESSION.sessionId);
    fireEvent.click(screen.getByTestId("session-card"));
    fireEvent.click(screen.getByTestId("session-card"));
    expect(mock.calls.openSession).toEqual([]);
  });
});

describe("SessionItem full-title tip", () => {
  /** jsdom has no layout: stamp the masked title span's overflow metrics. */
  function stampTitleWidths(scrollWidth: number, clientWidth: number): void {
    const el = document.querySelector(".session-item__title");
    if (el === null) throw new Error("title span not rendered");
    Object.defineProperty(el, "scrollWidth", { value: scrollWidth });
    Object.defineProperty(el, "clientWidth", { value: clientWidth });
  }

  it("resting the pointer on an OVERFLOWING title pops the full title beside the sidebar, and leaving hides it", () => {
    vi.useFakeTimers();
    try {
      setup("some-other-session");
      stampTitleWidths(300, 120); // masked: tail hidden
      fireEvent.mouseEnter(screen.getByTestId("session-card"));
      act(() => {
        vi.advanceTimersByTime(500); // past the hover intent
      });
      const tip = document.body.querySelector(".session-title-tip");
      expect(tip).not.toBeNull();
      expect(tip?.textContent).toBe("Test session");
      expect(tip?.getAttribute("aria-hidden")).toBe("true");
      fireEvent.mouseLeave(screen.getByTestId("session-card"));
      expect(document.body.querySelector(".session-title-tip")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows NO tip when the title fits inside the mask", () => {
    vi.useFakeTimers();
    try {
      setup("some-other-session");
      stampTitleWidths(100, 120); // fits — nothing hidden
      fireEvent.mouseEnter(screen.getByTestId("session-card"));
      act(() => {
        vi.advanceTimersByTime(500);
      });
      expect(document.body.querySelector(".session-title-tip")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("any scroll closes an open tip (fixed position would go stale)", () => {
    vi.useFakeTimers();
    try {
      setup("some-other-session");
      stampTitleWidths(300, 120);
      fireEvent.mouseEnter(screen.getByTestId("session-card"));
      act(() => {
        vi.advanceTimersByTime(500);
      });
      expect(document.body.querySelector(".session-title-tip")).not.toBeNull();
      act(() => {
        window.dispatchEvent(new Event("scroll"));
      });
      expect(document.body.querySelector(".session-title-tip")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("SessionItem badge", () => {
  it("shows Pending approval when the active session has a pending permission", () => {
    const mock = setup(SESSION.sessionId);
    emitPending(mock);
    expect(screen.getByText("Pending approval")).toBeInTheDocument();
  });

  it("does not show the badge on a non-active row", () => {
    const mock = setup("some-other-session");
    emitPending(mock);
    expect(screen.queryByText("Pending approval")).not.toBeInTheDocument();
  });

  it("disables the row and blocks open while a gate is pending", () => {
    const mock = setup(SESSION.sessionId);
    emitPending(mock);
    const card = screen.getByTestId("session-card");
    expect(card).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(card);
    expect(mock.calls.openSession).toEqual([]);
  });

  it("marks a NON-active row aria-disabled while a gate is pending (the dimmed-freeze hook)", () => {
    // The gate freezes ALL rows, not just the active one. The card is a
    // <div role=button>, so the dim/not-allowed visual is keyed on
    // [aria-disabled="true"]:not(.is-active) in CSS — assert the attribute
    // contract that visual depends on, plus the click block.
    const mock = setup("some-other-session");
    emitPending(mock);
    const card = screen.getByTestId("session-card");
    expect(card).toHaveAttribute("aria-disabled", "true");
    expect(card.className).not.toContain("is-active");
    fireEvent.click(card);
    expect(mock.calls.openSession).toEqual([]);
  });

  it("never carries a native title attribute (no OS hover tooltip)", () => {
    // The card used to mirror its title (and the gate hint) into `title`,
    // which pops the OS tooltip on every hover (user report 2026-06-13).
    // The two-line card already shows the full title; the gate state is
    // conveyed by the dimmed not-allowed visual.
    const mock = setup(SESSION.sessionId);
    expect(screen.getByTestId("session-card")).not.toHaveAttribute("title");
    emitPending(mock);
    expect(screen.getByTestId("session-card")).not.toHaveAttribute("title");
  });

  it("opens the session when no gate is pending", () => {
    const mock = setup("other-session");
    const card = screen.getByTestId("session-card");
    expect(card).toHaveAttribute("aria-disabled", "false");
    fireEvent.click(card);
    expect(mock.calls.openSession).toEqual([SESSION.sessionId]);
  });

  it("opens the session on Enter (keyboard parity for the div button)", () => {
    const mock = setup("other-session");
    fireEvent.keyDown(screen.getByTestId("session-card"), { key: "Enter" });
    expect(mock.calls.openSession).toEqual([SESSION.sessionId]);
  });

  it("renders the title and converges to it after a live title event", async () => {
    const mock = setup("other-session");
    expect(screen.getByText("Test session")).toBeInTheDocument();
    act(() => {
      mock.emitTitle({
        kind: "title",
        sessionId: SESSION.sessionId,
        title: "Test session",
      });
    });
    // The reveal fades the placeholder out then types the title in; assert the
    // row converges back to the full title.
    expect(
      await screen.findByText("Test session", {}, { timeout: 3000 }),
    ).toBeInTheDocument();
  });

  // UX review 2026-09-22, item 25: the live title was never cleared, so the
  // card typed it in again on every remount (a search filter, a move into
  // another day group).
  it("types a live title in once: a remount after the reveal shows it at once", async () => {
    const mock = createMockHertaBridge();
    const card = (key: string): JSX.Element => (
      <HertaBridgeProvider bridge={mock.bridge}>
        <SessionItem key={key} session={SESSION} title="排查失踪引用" />
      </HertaBridgeProvider>
    );
    const view = renderWithLocale(card("first"));
    act(() => {
      mock.emitTitle({
        kind: "title",
        sessionId: SESSION.sessionId,
        title: "排查失踪引用",
      });
    });
    // The reveal starts with the placeholder fading out, then types.
    expect(document.querySelector(".title-fade-out")).not.toBeNull();
    await screen.findByText("排查失踪引用", {}, { timeout: 3000 });
    expect(document.querySelector(".title-caret")).toBeNull();

    view.rerender(card("second"));
    expect(document.querySelector(".title-fade-out")).toBeNull();
    expect(document.querySelector(".title-caret")).toBeNull();
    expect(screen.getByText("排查失踪引用")).toBeInTheDocument();
  });
});

describe("SessionItem delete", () => {
  it("shows a trash button; clicking it reveals Confirm delete; clicking that deletes", () => {
    const mock = setup("other-session");
    const trash = screen.getByTestId("session-delete");
    expect(trash).toBeInTheDocument();
    fireEvent.click(trash);
    const confirm = screen.getByRole("button", { name: "Confirm delete" });
    fireEvent.click(confirm);
    expect(mock.calls.deleteSession).toEqual([SESSION.sessionId]);
  });

  it("a DOUBLE-click on the trash does not delete — the second click lands on the pill and is not its confirm (UX review 2026-09-22, item 3)", () => {
    const mock = setup("other-session");
    // The platform counts the clicks: detail 1, then 2 for the second
    // click of a double-click, which lands on the pill mounted in the
    // trash's own slot.
    fireEvent.click(screen.getByTestId("session-delete"), { detail: 1 });
    const confirm = screen.getByRole("button", { name: "Confirm delete" });
    fireEvent.click(confirm, { detail: 2 });
    expect(mock.calls.deleteSession).toEqual([]);
    // Still armed; a fresh click after reading it deletes.
    fireEvent.click(screen.getByRole("button", { name: "Confirm delete" }), {
      detail: 1,
    });
    expect(mock.calls.deleteSession).toEqual([SESSION.sessionId]);
  });

  it("keeps the confirm after click even if a spurious mouseEnter fires (no real leave)", () => {
    // Clicking the trash removes its <svg>, which can fire a spurious
    // onMouseEnter on the card (React rebuilds enter/leave from a detached
    // relatedTarget). Without a genuine prior leave, that must NOT cancel the
    // confirm — otherwise Confirm delete vanishes instantly on click.
    setup("other-session");
    fireEvent.click(screen.getByTestId("session-delete"));
    fireEvent.mouseEnter(screen.getByTestId("session-card"));
    expect(
      screen.getByRole("button", { name: "Confirm delete" }),
    ).toBeInTheDocument();
  });

  it("a genuine leave then re-enter cancels a pending confirm (back to trash)", () => {
    setup("other-session");
    fireEvent.click(screen.getByTestId("session-delete"));
    expect(
      screen.getByRole("button", { name: "Confirm delete" }),
    ).toBeInTheDocument();
    // Leaving does NOT swap to the trash (that swap caused the revert flash);
    // a real leave + re-enter resets to the trash.
    fireEvent.mouseLeave(screen.getByTestId("session-card"));
    fireEvent.mouseEnter(screen.getByTestId("session-card"));
    expect(
      screen.queryByRole("button", { name: "Confirm delete" }),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("session-delete")).toBeInTheDocument();
  });

  it("the pill mounts collapsed, grows via is-open one frame later, and shrinks on leave (width animation)", () => {
    // Deferred-rAF capture so the mount frame is observable: an immediate
    // rAF mock would open the pill inside the click's act(), hiding the
    // collapsed start state the width transition grows from.
    const rafCbs: FrameRequestCallback[] = [];
    const rafSpy = vi
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation((cb) => {
        rafCbs.push(cb);
        return rafCbs.length;
      });
    const cafSpy = vi
      .spyOn(window, "cancelAnimationFrame")
      .mockImplementation(() => {});
    try {
      setup("other-session");
      fireEvent.click(screen.getByTestId("session-delete"));
      const confirm = screen.getByRole("button", { name: "Confirm delete" });
      // Mount frame: collapsed — the growth's transition start state.
      expect(confirm.classList.contains("is-open")).toBe(false);
      act(() => {
        for (const cb of rafCbs.splice(0)) cb(0);
      });
      expect(confirm.classList.contains("is-open")).toBe(true);
      // Leave: the shrink starts IMMEDIATELY (is-open drops) while the pill
      // stays mounted and fading — no more blurred-title-only frames; the
      // trash swap follows via the delayed reset (covered by the next test).
      fireEvent.mouseLeave(screen.getByTestId("session-card"));
      expect(confirm.classList.contains("is-open")).toBe(false);
      expect(
        screen.getByRole("button", { name: "Confirm delete" }),
      ).toBeInTheDocument();
    } finally {
      rafSpy.mockRestore();
      cafSpy.mockRestore();
    }
  });

  it("swaps confirm back to the trash shortly after a genuine leave (releases the title's width)", () => {
    // The pill stays mounted through its fade-out (no trash flash), but an
    // invisible pill still squeezes the title, leaving its edge-fade over
    // visible characters. After the fade completes, the delayed reset swaps
    // in the trash so the title reclaims its width without needing a click.
    vi.useFakeTimers();
    try {
      setup("other-session");
      fireEvent.click(screen.getByTestId("session-delete"));
      fireEvent.mouseLeave(screen.getByTestId("session-card"));
      // Immediately after leave: still the pill (fading out in place).
      expect(
        screen.getByRole("button", { name: "Confirm delete" }),
      ).toBeInTheDocument();
      act(() => {
        vi.advanceTimersByTime(300); // past the 260ms post-shrink reset
      });
      expect(
        screen.queryByRole("button", { name: "Confirm delete" }),
      ).not.toBeInTheDocument();
      expect(screen.getByTestId("session-delete")).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("re-entering before the post-leave reset keeps the two-step flow sane (timer canceled)", () => {
    vi.useFakeTimers();
    try {
      setup("other-session");
      fireEvent.click(screen.getByTestId("session-delete"));
      fireEvent.mouseLeave(screen.getByTestId("session-card"));
      fireEvent.mouseEnter(screen.getByTestId("session-card"));
      // Genuine re-entry already reset to the trash; the stale timer must
      // not fire on top of a fresh confirm opened afterwards.
      fireEvent.click(screen.getByTestId("session-delete"));
      act(() => {
        vi.advanceTimersByTime(500);
      });
      expect(
        screen.getByRole("button", { name: "Confirm delete" }),
      ).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not open the session when trash / confirm are clicked (stopPropagation)", () => {
    const mock = setup("other-session");
    fireEvent.click(screen.getByTestId("session-delete"));
    fireEvent.click(screen.getByRole("button", { name: "Confirm delete" }));
    expect(mock.calls.openSession).toEqual([]);
  });

  it("hides the trash while an approval gate is pending (Pending approval)", () => {
    const mock = setup(SESSION.sessionId);
    emitPending(mock);
    expect(screen.queryByTestId("session-delete")).not.toBeInTheDocument();
    expect(screen.getByText("Pending approval")).toBeInTheDocument();
  });
});

describe("SessionItem — search-result landing (2026-07-27)", () => {
  /** Renders the store's pendingJump so the test can watch the request. */
  function JumpProbe(): JSX.Element {
    const pending = useSessionSelector((s) => s.pendingJump);
    return (
      <span data-testid="pending-jump">
        {pending === null
          ? "null"
          : `${pending.sessionId}:${pending.blockIndex}`}
      </span>
    );
  }

  function setupSearch(
    opts: {
      jumpIndex?: number;
      openSessionResult?: unknown;
      /** Session the store is already pointed at (omit = none open). */
      activeId?: string;
    } = {},
  ): MockHertaBridge {
    const mock = createMockHertaBridge(
      opts.openSessionResult !== undefined
        ? ({ openSessionResult: opts.openSessionResult } as never)
        : undefined,
    );
    renderWithLocale(
      <HertaBridgeProvider bridge={mock.bridge}>
        <SessionItem
          session={SESSION}
          title="Test session"
          searchSnippet="…needle…"
          {...(opts.jumpIndex !== undefined
            ? { searchJumpIndex: opts.jumpIndex }
            : {})}
        />
        <JumpProbe />
      </HertaBridgeProvider>,
    );
    if (opts.activeId !== undefined) {
      act(() => {
        mock.emitReset({
          sessionId: opts.activeId as string,
          workspaceRoot: "/repo",
          record: [],
          overlay: null,
          backendWorkspace: "/r",
          backendWorkspaceIsDefault: true,
        });
      });
    }
    return mock;
  }

  it("requests the jump BEFORE opening, tagged with the target session", () => {
    const mock = setupSearch({ jumpIndex: 7, activeId: "some-other-session" });
    fireEvent.click(screen.getByTestId("session-card"));
    // Synchronously, without waiting on the open: the reset preserves the
    // request so the conversation entrance can see it and stand down instead
    // of scrolling to the latest turn. Requesting after the open resolved put
    // it a commit too late (owner 2026-07-27, bug 1).
    expect(screen.getByTestId("pending-jump").textContent).toBe(
      `${SESSION.sessionId}:7`,
    );
    expect(mock.calls.openSession).toEqual([SESSION.sessionId]);
  });

  it("a search hit in the ALREADY-OPEN session jumps without re-opening", () => {
    // Bug 2 (owner 2026-07-27): the active-row guard made the click a total
    // no-op, so the one session you were already reading was the one you
    // could not jump within. Re-opening stays refused — it desyncs a running
    // turn — but navigation needs no open at all.
    const mock = setupSearch({ jumpIndex: 3, activeId: SESSION.sessionId });
    fireEvent.click(screen.getByTestId("session-card"));
    expect(mock.calls.openSession).toEqual([]);
    expect(screen.getByTestId("pending-jump").textContent).toBe(
      `${SESSION.sessionId}:3`,
    );
  });

  it("an ordinary (non-search) click requests no jump", () => {
    setupSearch({ activeId: "some-other-session" });
    fireEvent.click(screen.getByTestId("session-card"));
    expect(screen.getByTestId("pending-jump").textContent).toBe("null");
  });

  it("a pending gate blocks the jump too, active row or not", () => {
    const mock = setupSearch({ jumpIndex: 7, activeId: SESSION.sessionId });
    emitPending(mock);
    fireEvent.click(screen.getByTestId("session-card"));
    expect(screen.getByTestId("pending-jump").textContent).toBe("null");
  });

  it("a FAILED open drops the request (nothing to land in)", async () => {
    setupSearch({
      jumpIndex: 7,
      activeId: "some-other-session",
      openSessionResult: { openError: { code: "corrupt-line", line: 3 } },
    });
    fireEvent.click(screen.getByTestId("session-card"));
    expect(screen.getByTestId("pending-jump").textContent).not.toBe("null");
    await act(async () => {
      await Promise.resolve();
    });
    // Otherwise it would outlive the failure and fire against whichever
    // session the user opened next.
    expect(screen.getByTestId("pending-jump").textContent).toBe("null");
  });
});

describe("SessionItem corrupt-open badge", () => {
  function setupCorrupt(): MockHertaBridge {
    const mock = createMockHertaBridge({
      openSessionResult: { openError: { code: "corrupt-line", line: 3 } },
    });
    renderWithLocale(
      <HertaBridgeProvider bridge={mock.bridge}>
        <SessionItem session={SESSION} title="Test session" />
      </HertaBridgeProvider>,
    );
    return mock;
  }

  it("shows the damaged badge when the open reports a corrupt archive", async () => {
    const mock = setupCorrupt();
    fireEvent.click(screen.getByTestId("session-card"));
    expect(await screen.findByText("Archive damaged")).toBeInTheDocument();
    expect(mock.calls.openSession).toEqual([SESSION.sessionId]);
  });

  it("clicking the badge dismisses it immediately — the trash returns without waiting", async () => {
    const mock = setupCorrupt();
    fireEvent.click(screen.getByTestId("session-card"));
    const badge = await screen.findByText("Archive damaged");
    fireEvent.click(badge);
    // No timers advanced: the dismissal is instant.
    expect(screen.queryByText("Archive damaged")).not.toBeInTheDocument();
    expect(screen.getByTestId("session-delete")).toBeInTheDocument();
    // Dismissing must NOT re-open the corrupt session (stopPropagation).
    expect(mock.calls.openSession).toEqual([SESSION.sessionId]);
  });

  it("a genuine mouse-leave swaps the badge for the trash shortly after (like 确认删除)", async () => {
    vi.useFakeTimers();
    try {
      setupCorrupt();
      fireEvent.click(screen.getByTestId("session-card"));
      await act(async () => {});
      expect(screen.getByText("Archive damaged")).toBeInTheDocument();
      // Leaving the card: the hover-reveal fades the badge out in place;
      // shortly after, the reset swaps in the trash (mirrors the confirm
      // pill's post-fade reset — never a lingering badge on an unhovered
      // card that later pops into an invisible trash).
      fireEvent.mouseLeave(screen.getByTestId("session-card"));
      expect(screen.getByText("Archive damaged")).toBeInTheDocument(); // fading, still mounted
      act(() => {
        vi.advanceTimersByTime(300); // past the shared 260ms post-fade reset
      });
      expect(screen.queryByText("Archive damaged")).not.toBeInTheDocument();
      expect(screen.getByTestId("session-delete")).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("re-entering after a genuine leave dismisses the badge immediately", async () => {
    vi.useFakeTimers();
    try {
      setupCorrupt();
      fireEvent.click(screen.getByTestId("session-card"));
      await act(async () => {});
      fireEvent.mouseLeave(screen.getByTestId("session-card"));
      fireEvent.mouseEnter(screen.getByTestId("session-card"));
      // No timer advance needed: re-entry resets to the trash right away.
      expect(screen.queryByText("Archive damaged")).not.toBeInTheDocument();
      expect(screen.getByTestId("session-delete")).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("auto-reverts the badge to the trash (delete stays reachable)", async () => {
    vi.useFakeTimers();
    try {
      setupCorrupt();
      fireEvent.click(screen.getByTestId("session-card"));
      // Flush the openSession promise (microtask — no timer needed).
      await act(async () => {});
      expect(screen.getByText("Archive damaged")).toBeInTheDocument();
      act(() => {
        vi.advanceTimersByTime(4100);
      });
      expect(screen.queryByText("Archive damaged")).not.toBeInTheDocument();
      expect(screen.getByTestId("session-delete")).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("SessionItem two-line", () => {
  it("renders title + last user message for a titled (inactive) session", () => {
    const mock = createMockHertaBridge();
    const session = {
      sessionId: "s-x",
      workspaceRoot: "/r",
      startedAt: "",
      lastActivityAt: "",
      title: "排查解析报错",
      lastUserText: "帮我看看 parser.ts",
    };
    renderWithLocale(
      <HertaBridgeProvider bridge={mock.bridge}>
        <SessionItem session={session} title="排查解析报错" />
      </HertaBridgeProvider>,
    );
    expect(screen.getByText("排查解析报错")).toBeInTheDocument();
    expect(screen.getByText("帮我看看 parser.ts")).toBeInTheDocument();
  });

  it("aliases 板砖→Brick in an EN session's preview (keyed on the card's own lang)", () => {
    const mock = createMockHertaBridge();
    const session = {
      sessionId: "s-en",
      workspaceRoot: "/r",
      startedAt: "",
      lastActivityAt: "",
      title: "Parser fix",
      // The record stores the wire token @板砖 (the composer translated @brick);
      // the card must show @Brick, matching its own bubbles.
      lastUserText: "hand @板砖 the parser bug",
      lang: "en" as const,
    };
    renderWithLocale(
      <HertaBridgeProvider bridge={mock.bridge}>
        <SessionItem session={session} title="Parser fix" />
      </HertaBridgeProvider>,
    );
    expect(screen.getByText("hand @Brick the parser bug")).toBeInTheDocument();
    expect(
      screen.queryByText("hand @板砖 the parser bug"),
    ).not.toBeInTheDocument();
  });

  it("keeps 板砖 literal in a zh session's preview (byte-identical)", () => {
    const mock = createMockHertaBridge();
    const session = {
      sessionId: "s-zh",
      workspaceRoot: "/r",
      startedAt: "",
      lastActivityAt: "",
      title: "解析修复",
      lastUserText: "把 parser 的活交给 @板砖",
      lang: "zh" as const,
    };
    renderWithLocale(
      <HertaBridgeProvider bridge={mock.bridge}>
        <SessionItem session={session} title="解析修复" />
      </HertaBridgeProvider>,
    );
    expect(screen.getByText("把 parser 的活交给 @板砖")).toBeInTheDocument();
  });

  it("single-line (no preview) when the session has no title", () => {
    const mock = createMockHertaBridge();
    const session = {
      sessionId: "s-y",
      workspaceRoot: "/r",
      startedAt: "",
      lastActivityAt: "",
      lastUserText: "should not show without a title",
    };
    renderWithLocale(
      <HertaBridgeProvider bridge={mock.bridge}>
        <SessionItem session={session} title="Untitled" />
      </HertaBridgeProvider>,
    );
    expect(screen.getByText("Untitled")).toBeInTheDocument();
    expect(
      screen.queryByText("should not show without a title"),
    ).not.toBeInTheDocument();
  });

  it("active session preview uses the activation's first message, not lastUserText", async () => {
    const mock = createMockHertaBridge();
    const session = {
      sessionId: "s-act",
      workspaceRoot: "/r",
      startedAt: "",
      lastActivityAt: "",
      title: "T",
      lastUserText: "old last message",
    };
    renderWithLocale(
      <HertaBridgeProvider bridge={mock.bridge}>
        <SessionItem session={session} title="T" />
      </HertaBridgeProvider>,
    );
    act(() => {
      mock.emitReset({
        sessionId: "s-act",
        workspaceRoot: "/r",
        record: [],
        overlay: null,
        backendWorkspace: "/r",
        backendWorkspaceIsDefault: true,
      });
    });
    act(() => {
      mock.emitRecord({
        kind: "block",
        blockId: "b1",
        block: { kind: "user", text: "first message this activation" },
      });
    });
    // The preview cross-fades from lastUserText to the activation's first
    // message, so the swap lands after the fade.
    expect(
      await screen.findByText("first message this activation"),
    ).toBeInTheDocument();
    expect(screen.queryByText("old last message")).not.toBeInTheDocument();
  });
});

describe("SessionItem mid-turn switch guard", () => {
  it("the first click mid-turn ARMS instead of switching; the second click switches", () => {
    const mock = setup("some-other-session");
    act(() => {
      mock.emitTurn({ kind: "started", turnId: "t1" });
    });
    const card = screen.getByTestId("session-card");
    fireEvent.click(card);
    // Armed, not switched: the warning badge takes the action slot.
    expect(mock.calls.openSession).toEqual([]);
    expect(
      screen.getByText(
        "This interrupts the current reply — click again to confirm",
      ),
    ).toBeInTheDocument();
    fireEvent.click(card);
    expect(mock.calls.openSession).toEqual([SESSION.sessionId]);
  });

  it("a DOUBLE-click mid-turn only arms — it never interrupts the reply the arm protects (UX review 2026-09-22, item 3)", () => {
    const mock = setup("some-other-session");
    act(() => {
      mock.emitTurn({ kind: "started", turnId: "t1" });
    });
    const card = screen.getByTestId("session-card");
    fireEvent.click(card, { detail: 1 });
    fireEvent.click(card, { detail: 2 });
    expect(mock.calls.openSession).toEqual([]);
    expect(
      screen.getByText(
        "This interrupts the current reply — click again to confirm",
      ),
    ).toBeInTheDocument();
    fireEvent.click(card, { detail: 1 });
    expect(mock.calls.openSession).toEqual([SESSION.sessionId]);
  });

  it("the arm times out with an ANIMATED exit; a later click re-arms rather than switching", () => {
    vi.useFakeTimers();
    const mock = setup("some-other-session");
    act(() => {
      mock.emitTurn({ kind: "started", turnId: "t1" });
    });
    const card = screen.getByTestId("session-card");
    fireEvent.click(card);
    const badge = screen.getByText(
      "This interrupts the current reply — click again to confirm",
    );
    // The arming rAF opens the width transition one frame after mount.
    act(() => {
      vi.advanceTimersByTime(32);
    });
    expect(badge.className).toContain("is-open");
    act(() => {
      vi.advanceTimersByTime(4000);
    });
    // Exit in flight: is-open dropped (the melt-away), still mounted…
    expect(badge.className).not.toContain("is-open");
    expect(badge).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(200);
    });
    // …then unmounted once the shrink finishes.
    expect(
      screen.queryByText(
        "This interrupts the current reply — click again to confirm",
      ),
    ).not.toBeInTheDocument();
    fireEvent.click(card);
    expect(mock.calls.openSession).toEqual([]); // re-armed — still guarded
    vi.useRealTimers();
  });

  it("disarms when the turn ends — the next click switches immediately", () => {
    vi.useFakeTimers();
    const mock = setup("some-other-session");
    act(() => {
      mock.emitTurn({ kind: "started", turnId: "t1" });
    });
    const card = screen.getByTestId("session-card");
    fireEvent.click(card);
    expect(mock.calls.openSession).toEqual([]);
    act(() => {
      mock.emitTurn({ kind: "finished", turnId: "t1" });
    });
    act(() => {
      vi.advanceTimersByTime(200); // the badge's animated exit completes
    });
    expect(
      screen.queryByText(
        "This interrupts the current reply — click again to confirm",
      ),
    ).not.toBeInTheDocument();
    fireEvent.click(card);
    expect(mock.calls.openSession).toEqual([SESSION.sessionId]);
    vi.useRealTimers();
  });
});

describe("SessionItem live pulse", () => {
  // "Shows a steady dot", not "pulses", since 2026-07-27: the blink joined
  // two other identical pulses during a dispatch, and the dot's job (a
  // standing "switching away interrupts" fact) never needed one. The
  // presence fade these assertions pin is unchanged.
  it("the ACTIVE row shows the live dot while a turn is in flight and fades it out when it ends", () => {
    vi.useFakeTimers();
    const mock = setup(SESSION.sessionId);
    expect(document.querySelector(".session-item__live")).toBeNull();
    act(() => {
      mock.emitTurn({ kind: "started", turnId: "t1" });
    });
    expect(document.querySelector(".session-item__live")).not.toBeNull();
    // The arming rAF opens the fade-in one frame after mount.
    act(() => {
      vi.advanceTimersByTime(32);
    });
    expect(document.querySelector(".session-item__live.is-on")).not.toBeNull();
    act(() => {
      mock.emitTurn({ kind: "finished", turnId: "t1" });
    });
    // Exit in flight: is-on dropped, still mounted for the fade-out…
    expect(document.querySelector(".session-item__live.is-on")).toBeNull();
    expect(document.querySelector(".session-item__live")).not.toBeNull();
    act(() => {
      vi.advanceTimersByTime(250);
    });
    // …then unmounted.
    expect(document.querySelector(".session-item__live")).toBeNull();
    vi.useRealTimers();
  });

  it("a NON-active row never shows the dot (the signal belongs to the open session)", () => {
    const mock = setup("some-other-session");
    act(() => {
      mock.emitTurn({ kind: "started", turnId: "t1" });
    });
    expect(document.querySelector(".session-item__live")).toBeNull();
  });
});

describe("SessionItem tray-refusal arm (2026-07-13)", () => {
  const WARN = "This interrupts the current reply — click again to confirm";

  it("a navBlocked event targeting this session ARMS the badge; the next click switches", () => {
    const mock = setup("some-other-session");
    act(() => {
      mock.emitTurn({ kind: "started", turnId: "t1" });
    });
    act(() => {
      mock.emitNavBlocked({ target: SESSION.sessionId });
    });
    expect(screen.getByText(WARN)).toBeInTheDocument();
    // The tray attempt WAS the first step — a direct click now confirms.
    fireEvent.click(screen.getByTestId("session-card"));
    expect(mock.calls.openSession).toEqual([SESSION.sessionId]);
  });

  it("a navBlocked event for a DIFFERENT target does not arm this row", () => {
    const mock = setup("some-other-session");
    act(() => {
      mock.emitTurn({ kind: "started", turnId: "t1" });
    });
    act(() => {
      mock.emitNavBlocked({ target: "someone-else" });
    });
    expect(screen.queryByText(WARN)).not.toBeInTheDocument();
    act(() => {
      mock.emitNavBlocked({ target: null }); // new-chat refusal — TopBar's
    });
    expect(screen.queryByText(WARN)).not.toBeInTheDocument();
  });

  it("ignores the signal when no turn is in flight (stale/raced event)", () => {
    const mock = setup("some-other-session");
    act(() => {
      mock.emitNavBlocked({ target: SESSION.sessionId });
    });
    expect(screen.queryByText(WARN)).not.toBeInTheDocument();
  });

  it("the tray arm auto-disarms on the same timer as a click arm", () => {
    vi.useFakeTimers();
    const mock = setup("some-other-session");
    act(() => {
      mock.emitTurn({ kind: "started", turnId: "t1" });
    });
    act(() => {
      mock.emitNavBlocked({ target: SESSION.sessionId });
    });
    expect(screen.getByText(WARN)).toBeInTheDocument();
    // Two advances: the disarm setState only re-renders when the first act
    // flushes; the presence exit timer is scheduled by the re-render's
    // effect, so it needs its own advance (same split as the click-arm
    // timeout test above).
    act(() => {
      vi.advanceTimersByTime(4000);
    });
    act(() => {
      vi.advanceTimersByTime(250);
    });
    expect(screen.queryByText(WARN)).not.toBeInTheDocument();
    // Disarmed — the next click re-arms instead of switching.
    fireEvent.click(screen.getByTestId("session-card"));
    expect(mock.calls.openSession).toEqual([]);
    vi.useRealTimers();
  });
});
