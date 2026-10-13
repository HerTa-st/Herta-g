import { act, fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { HertaBridgeProvider } from "../../context/HertaBridgeContext.js";
import { renderWithLocale } from "../../i18n/test-util.js";
import {
  createMockHertaBridge,
  type MockHertaBridge,
} from "../../ipc/mock-bridge.js";
import { CONNECT_EXIT_MS } from "./ConnectStation.js";
import { Workspace } from "./Workspace.js";

/** How long the disconnect composer→button morph rises (must match
 *  useConnectMorph's MORPH_MS); the static button appears on settle. */
const CONNECT_MORPH_MS = 800;

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

function emitPending(mock: MockHertaBridge): void {
  act(() => {
    mock.emitOverlay({
      kind: "pending",
      overlay: {
        kind: "pending-permission",
        requestId: "req-1",
        risk: "workspace_write",
        tool: "write_new_file",
        summary: "write a file",
      },
    });
  });
}

describe("Workspace — the pane speaks the session's language (ADR 0019, amended 2026-10-13)", () => {
  it("an English session in the Chinese app: the composer and the approval card read in English", async () => {
    // Seen live: an English session showed a 请求权限 card and 给黑塔发消息….
    const mock = createMockHertaBridge();
    renderWithLocale(
      <HertaBridgeProvider bridge={mock.bridge}>
        <Workspace />
      </HertaBridgeProvider>,
      { locale: "zh" },
    );
    const open = (lang: "zh" | "en", sessionId: string): void =>
      act(() => {
        mock.emitReset({
          sessionId,
          workspaceRoot: "/r",
          record: [],
          overlay: null,
          backendWorkspace: "/r",
          backendWorkspaceIsDefault: true,
          lang,
        });
      });
    open("en", "s-en");
    await settle();
    expect(screen.getByPlaceholderText("Message Herta…")).toBeInTheDocument();
    emitPending(mock);
    expect(
      screen.getByTestId("approval-panel").getAttribute("aria-label"),
    ).toBe("Permission request");
    // A Chinese session in the same app reads in Chinese.
    open("zh", "s-zh");
    await settle();
    expect(screen.getByPlaceholderText("给黑塔发消息…")).toBeInTheDocument();
  });
});

describe("Workspace", () => {
  it("renders the tide wave at the composer's floor (voice card retired)", async () => {
    const mock = createMockHertaBridge();
    const { container } = renderWithLocale(
      <HertaBridgeProvider bridge={mock.bridge}>
        <Workspace />
      </HertaBridgeProvider>,
    );
    await settle();
    const wave = container.querySelector(".composer .composer-wave");
    expect(wave).not.toBeNull();
    expect(wave?.querySelector("canvas.aura-canvas")).not.toBeNull();
  });

  it("surfaces the approval panel when a permission is pending", async () => {
    const mock = createMockHertaBridge();
    renderWithLocale(
      <HertaBridgeProvider bridge={mock.bridge}>
        <Workspace />
      </HertaBridgeProvider>,
    );
    await settle();
    expect(screen.queryByTestId("approval-panel")).not.toBeInTheDocument();
    emitPending(mock);
    expect(screen.getByTestId("approval-panel")).toBeInTheDocument();
  });

  it("suppresses the composer while a permission is pending, restores it after", async () => {
    const mock = createMockHertaBridge();
    const { container } = renderWithLocale(
      <HertaBridgeProvider bridge={mock.bridge}>
        <Workspace />
      </HertaBridgeProvider>,
    );
    await settle();
    const composer = container.querySelector(".composer");
    expect(composer).not.toBeNull();
    expect(composer?.classList.contains("is-suppressed")).toBe(false);

    emitPending(mock);
    expect(composer?.classList.contains("is-suppressed")).toBe(true);

    act(() => {
      mock.emitOverlay({ kind: "resolved", requestId: "req-1" });
    });
    expect(composer?.classList.contains("is-suppressed")).toBe(false);
  });

  it("wraps the composer and panel in a workspace-footer", async () => {
    const mock = createMockHertaBridge();
    const { container } = renderWithLocale(
      <HertaBridgeProvider bridge={mock.bridge}>
        <Workspace />
      </HertaBridgeProvider>,
    );
    await settle();
    const footer = container.querySelector(".workspace-footer");
    expect(footer).not.toBeNull();
    expect(footer?.querySelector(".composer")).not.toBeNull();
  });

  it("shows the Connect to Herta button when disconnected, hides it on reconnect", async () => {
    vi.useFakeTimers();
    try {
      const mock = createMockHertaBridge();
      const { container } = renderWithLocale(
        <HertaBridgeProvider bridge={mock.bridge}>
          <Workspace />
        </HertaBridgeProvider>,
      );
      await act(async () => {
        await Promise.resolve();
      });

      // Initially bootstrapped=false → not disconnected → button absent.
      expect(
        screen.queryByRole("button", { name: /Connect to Herta/ }),
      ).not.toBeInTheDocument();

      // Bootstrap with a session, then delete it → disconnected.
      act(() => {
        mock.emitReset({
          sessionId: "s1",
          workspaceRoot: "/tmp",
          record: [],
          overlay: null,
          title: null,
          backendWorkspace: "/tmp",
          backendWorkspaceIsDefault: true,
        });
      });
      act(() => {
        mock.emitSessionDeleted({ sessionId: "s1" });
      });
      // A6: the disconnect direction now MORPHS — the composer rises into the
      // button. During the morph the workspace flags `is-morphing` and the
      // static button is withheld (the flying clone is the visible riser).
      const ws = container.querySelector(".workspace");
      expect(ws?.classList.contains("is-morphing")).toBe(true);
      expect(
        screen.queryByRole("button", { name: /Connect to Herta/ }),
      ).not.toBeInTheDocument();
      // The flying clone carries the composer's content (placeholder + send)
      // AND the target label, so the rise reads as the composer becoming the
      // button (it cross-fades to the label via CSS).
      const clone = container.querySelector(".connect-morph-clone");
      expect(clone).not.toBeNull();
      expect(
        clone?.querySelector(".connect-morph-clone-placeholder"),
      ).not.toBeNull();
      expect(clone?.querySelector(".connect-morph-clone-send")).not.toBeNull();
      expect(clone?.querySelector(".connect-morph-clone-label")).not.toBeNull();

      // Once the morph rise settles the static button takes over at the centre.
      act(() => {
        vi.advanceTimersByTime(CONNECT_MORPH_MS + 50);
      });
      expect(ws?.classList.contains("is-morphing")).toBe(false);
      expect(
        screen.getByRole("button", { name: /Connect to Herta/ }),
      ).toBeInTheDocument();

      // Reconnect: emit a new session reset → show=false on ConnectStation.
      act(() => {
        mock.emitReset({
          sessionId: "s2",
          workspaceRoot: "/tmp",
          record: [],
          overlay: null,
          title: null,
          backendWorkspace: "/tmp",
          backendWorkspaceIsDefault: true,
        });
      });
      // Button still present (exit animation playing).
      expect(
        screen.getByRole("button", { name: /Connect to Herta/ }),
      ).toBeInTheDocument();

      // Advance past the exit timer → button unmounts.
      act(() => {
        vi.advanceTimersByTime(CONNECT_EXIT_MS + 50);
      });
      expect(
        screen.queryByRole("button", { name: /Connect to Herta/ }),
      ).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("clicking the connect button starts the reconnect morph", () => {
    vi.useFakeTimers();
    vi.stubGlobal("matchMedia", () => ({
      matches: false,
      addEventListener() {},
      removeEventListener() {},
    }));
    try {
      const mock = createMockHertaBridge();
      const { container } = renderWithLocale(
        <HertaBridgeProvider bridge={mock.bridge}>
          <Workspace />
        </HertaBridgeProvider>,
      );
      // Bootstrap to the disconnected state (bootstrapped=true, sessionId=null).
      // noSession emits set bootstrapped=true with no sessionId → disconnected.
      // useConnectMorph fires → is-morphing; advance past it so the static button
      // appears (same approach as the existing disconnect-morph test).
      act(() => {
        mock.emitReset({ noSession: true });
      });
      act(() => {
        vi.advanceTimersByTime(CONNECT_MORPH_MS + 50);
      });
      const btn = screen.getByRole("button", { name: "Connect to Herta" });
      act(() => {
        fireEvent.click(btn);
      });
      expect(container.querySelector(".reconnect-morph-clone")).not.toBeNull();
      expect(
        container.querySelector(".workspace.is-reconnecting"),
      ).not.toBeNull();
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });
});
