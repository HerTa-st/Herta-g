import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { HertaBridgeProvider } from "../../context/HertaBridgeContext.js";
import { renderWithLocale } from "../../i18n/test-util.js";
import { createMockHertaBridge } from "../../ipc/mock-bridge.js";
import { Composer } from "./Composer.js";
import { WorkspaceRefsProvider } from "./WorkspaceRefs.js";

afterEach(() => {
  cleanup();
});

function renderComposer(mock = createMockHertaBridge()) {
  renderWithLocale(
    <WorkspaceRefsProvider>
      <HertaBridgeProvider bridge={mock.bridge}>
        <Composer />
      </HertaBridgeProvider>
    </WorkspaceRefsProvider>,
  );
  return mock;
}

function reset(
  mock: ReturnType<typeof createMockHertaBridge>,
  resumable: boolean,
): void {
  act(() =>
    mock.emitReset({
      sessionId: "s1",
      workspaceRoot: "/mock",
      record: [],
      overlay: null,
      backendWorkspace: "/mock",
      backendWorkspaceIsDefault: true,
      lang: "en",
      ...(resumable ? { resumable: true } : {}),
    }),
  );
}

const strip = () => screen.queryByTestId("composer-resume");

describe("the 继续 strip (ADR 0071 §1.4)", () => {
  it("offers Continue when main says the last run can be continued, and sends it once pressed", async () => {
    const mock = renderComposer();
    reset(mock, true);
    expect(strip()).toHaveTextContent("Brick's last run was interrupted.");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Continue/ }));
    });
    expect(mock.calls.continueInterrupted).toBe(1);
    // Gone at once: the turn's own lifecycle takes the composer over.
    expect(strip()).toBeNull();
  });

  it("follows main's word on the offer", () => {
    const mock = renderComposer();
    reset(mock, false);
    expect(strip()).toBeNull();
    act(() => mock.emitResume({ kind: "offer", resumable: true }));
    expect(strip()).not.toBeNull();
    act(() => mock.emitResume({ kind: "offer", resumable: false }));
    expect(strip()).toBeNull();
  });

  it("is not shown while a turn runs", () => {
    const mock = renderComposer();
    reset(mock, true);
    act(() => mock.emitTurn({ kind: "started", turnId: "t1" }));
    expect(strip()).toBeNull();
  });

  it("comes back when there is no key yet, so it can be pressed again", async () => {
    const mock = renderComposer(
      createMockHertaBridge({ continueInterruptedResult: { needsKey: true } }),
    );
    reset(mock, true);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Continue/ }));
    });
    expect(strip()).not.toBeNull();
  });

  it("a bridge that cannot continue never shows it", () => {
    const mock = createMockHertaBridge();
    const { continueInterrupted: _drop, ...rest } = mock.bridge;
    renderComposer({ ...mock, bridge: rest });
    reset(mock, true);
    expect(strip()).toBeNull();
  });
});
