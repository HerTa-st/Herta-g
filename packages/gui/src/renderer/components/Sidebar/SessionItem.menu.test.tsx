import type { SessionMetadata, TerminalRecordBlock } from "@herta/app-server";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { HertaBridgeProvider } from "../../context/HertaBridgeContext.js";
import { useSessionList } from "../../hooks/useSessionList.js";
import { useSessionSelector } from "../../hooks/useSessionSelector.js";
import { renderWithLocale } from "../../i18n/test-util.js";
import {
  createMockHertaBridge,
  type MockHertaBridge,
  type MockHertaBridgeOpts,
} from "../../ipc/mock-bridge.js";
import { SessionItem } from "./SessionItem.js";
import { sessionDisplayTitle } from "./session-display-title.js";

const SESSION: SessionMetadata = {
  sessionId: "s-menu",
  workspaceRoot: "/repo",
  startedAt: "2026-09-29T06:00:00.000Z",
  lastActivityAt: "2026-09-29T06:00:00.000Z",
  title: "旧名字",
  lastUserText: "hi",
};

/** The sidebar's own wiring, cut down: the card reads its session from the
 *  list store (so a rename shows), beside the open session's header title. */
function Harness(): JSX.Element {
  const list = useSessionList();
  const header = useSessionSelector((s) => s.title);
  const topics = useSessionSelector((s) => s.topics);
  const s = list.find((x) => x.sessionId === SESSION.sessionId);
  return (
    <>
      <span data-testid="header">{header ?? ""}</span>
      <span data-testid="topics">{topics.map((t) => t.title).join("|")}</span>
      {s !== undefined && (
        <SessionItem session={s} title={sessionDisplayTitle(s)} />
      )}
    </>
  );
}

/** The open session has a message: a rename names its current topic, so
 *  one with none offers no rename (see the last test). */
const SPOKEN: TerminalRecordBlock[] = [
  { kind: "user", text: "hi" } as TerminalRecordBlock,
];

async function setup(
  opts: MockHertaBridgeOpts = {},
  activeId = SESSION.sessionId,
  record: TerminalRecordBlock[] = SPOKEN,
): Promise<MockHertaBridge> {
  const mock = createMockHertaBridge({
    listSessionsResult: [SESSION],
    sessionActions: {},
    ...opts,
  });
  renderWithLocale(
    <HertaBridgeProvider bridge={mock.bridge}>
      <Harness />
    </HertaBridgeProvider>,
    { locale: "zh" },
  );
  act(() => {
    mock.emitReset({
      sessionId: activeId,
      workspaceRoot: "/repo",
      record,
      overlay: null,
      title: activeId === SESSION.sessionId ? "旧名字" : null,
      backendWorkspace: "/r",
      backendWorkspaceIsDefault: true,
    });
  });
  await screen.findByTestId("session-card");
  return mock;
}

const card = (): HTMLElement => screen.getByTestId("session-card");
const menu = (): HTMLElement | null => document.querySelector(".session-menu");

function rightClick(x = 40, y = 60): boolean {
  return fireEvent.contextMenu(card(), { button: 2, clientX: x, clientY: y });
}

describe("the session menu (ADR 0072 §3)", () => {
  it("an open session with no message yet offers no rename: there is no topic to name (review 2026-09-30)", async () => {
    await setup({}, SESSION.sessionId, []);
    rightClick(40, 60);
    const items = [
      ...(menu()?.querySelectorAll("[role='menuitem']") ?? []),
    ].map((b) => b.textContent);
    expect(items).toEqual(["导出为 Markdown…"]);
  });

  it("opens at the pointer with rename and export, and opens nothing else", async () => {
    const mock = await setup({}, "another-session");
    const defaulted = !rightClick(40, 60);
    expect(defaulted).toBe(true); // the OS menu is not shown
    const m = menu();
    expect(m).not.toBeNull();
    expect(m?.getAttribute("role")).toBe("menu");
    expect(m?.style.left).toBe("40px");
    expect(m?.style.top).toBe("60px");
    const items = [...(m?.querySelectorAll("[role='menuitem']") ?? [])].map(
      (b) => b.textContent,
    );
    expect(items).toEqual(["重命名", "导出为 Markdown…"]);
    // The first item has the keyboard.
    expect(document.activeElement?.textContent).toBe("重命名");
    // A click inside the portal never reaches the card (which would open
    // the session).
    fireEvent.click(m as HTMLElement);
    expect(mock.calls.openSession).toEqual([]);
  });

  it("is not offered where the bridge has no such surface — the right-click is left alone", async () => {
    const mock = createMockHertaBridge({ listSessionsResult: [SESSION] });
    renderWithLocale(
      <HertaBridgeProvider bridge={mock.bridge}>
        <Harness />
      </HertaBridgeProvider>,
      { locale: "zh" },
    );
    await screen.findByTestId("session-card");
    expect(rightClick()).toBe(true); // not prevented
    expect(menu()).toBeNull();
  });

  it("Escape closes it, hands focus back to the card, and never reaches the window (the approval panel listens there)", async () => {
    await setup();
    rightClick();
    const onWindow = vi.fn();
    window.addEventListener("keydown", onWindow);
    try {
      fireEvent.keyDown(document.activeElement as Element, { key: "Escape" });
      expect(onWindow).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("keydown", onWindow);
    }
    expect(menu()?.classList.contains("is-leaving")).toBe(true);
    expect(document.activeElement).toBe(card());
  });

  it("↓ and ↑ walk the items", async () => {
    await setup();
    rightClick();
    fireEvent.keyDown(document.activeElement as Element, { key: "ArrowDown" });
    expect(document.activeElement?.textContent).toBe("导出为 Markdown…");
    fireEvent.keyDown(document.activeElement as Element, { key: "ArrowDown" });
    expect(document.activeElement?.textContent).toBe("重命名");
    fireEvent.keyDown(document.activeElement as Element, { key: "ArrowUp" });
    expect(document.activeElement?.textContent).toBe("导出为 Markdown…");
  });
});

describe("rename in place (ADR 0072 §3)", () => {
  function field(): HTMLInputElement {
    const el = document.querySelector<HTMLInputElement>(
      ".session-item__rename",
    );
    if (el === null) throw new Error("no rename field");
    return el;
  }

  it("the menu's rename opens a field on the title; Enter keeps the name, on the card and in the header, with no reveal", async () => {
    const mock = await setup();
    rightClick();
    fireEvent.click(screen.getByText("重命名"));
    expect(field().value).toBe("旧名字");
    expect(document.activeElement).toBe(field());
    fireEvent.change(field(), { target: { value: "  新名字 " } });
    fireEvent.keyDown(field(), { key: "Enter" });
    expect(mock.calls.renameSession).toEqual([[SESSION.sessionId, "新名字"]]);
    expect(document.querySelector(".session-item__rename")).toBeNull();
    expect(card().querySelector(".session-item__title")?.textContent).toBe(
      "新名字",
    );
    expect(screen.getByTestId("header").textContent).toBe("新名字");
    expect(document.activeElement).toBe(card());
    // Enter in the field never reached the card (which opens on Enter).
    expect(mock.calls.openSession).toEqual([]);
  });

  it("F2 on the card renames too; leaving the field keeps what was typed", async () => {
    const mock = await setup();
    fireEvent.keyDown(card(), { key: "F2" });
    fireEvent.change(field(), { target: { value: "离开时保存" } });
    fireEvent.blur(field());
    expect(mock.calls.renameSession).toEqual([
      [SESSION.sessionId, "离开时保存"],
    ]);
  });

  it("Escape keeps the old name and sends nothing", async () => {
    const mock = await setup();
    fireEvent.keyDown(card(), { key: "F2" });
    fireEvent.change(field(), { target: { value: "不要了" } });
    fireEvent.keyDown(field(), { key: "Escape" });
    expect(mock.calls.renameSession).toEqual([]);
    expect(card().querySelector(".session-item__title")?.textContent).toBe(
      "旧名字",
    );
  });

  it("an IME's Enter picks a candidate — it does not keep the name", async () => {
    const mock = await setup();
    fireEvent.keyDown(card(), { key: "F2" });
    fireEvent.change(field(), { target: { value: "xin" } });
    fireEvent.keyDown(field(), { key: "Enter", isComposing: true });
    expect(mock.calls.renameSession).toEqual([]);
    expect(document.querySelector(".session-item__rename")).not.toBeNull();
  });

  it("an unchanged or empty name sends nothing", async () => {
    const mock = await setup();
    fireEvent.keyDown(card(), { key: "F2" });
    fireEvent.keyDown(field(), { key: "Enter" });
    fireEvent.keyDown(card(), { key: "F2" });
    fireEvent.change(field(), { target: { value: "   " } });
    fireEvent.keyDown(field(), { key: "Enter" });
    expect(mock.calls.renameSession).toEqual([]);
  });

  it("a rename main could not keep goes back, and says so", async () => {
    await setup({ sessionActions: { renameResult: { ok: false } } });
    fireEvent.keyDown(card(), { key: "F2" });
    fireEvent.change(field(), { target: { value: "新名字" } });
    fireEvent.keyDown(field(), { key: "Enter" });
    // The notice mounts a render after the title goes back (its presence
    // hook mounts it in an effect): wait for the notice, not the title.
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toBe("重命名失败"),
    );
    expect(card().querySelector(".session-item__title")?.textContent).toBe(
      "旧名字",
    );
    expect(screen.getByTestId("header").textContent).toBe("旧名字");
  });

  it("takes the name as main kept it", async () => {
    await setup({
      sessionActions: { renameResult: { ok: true, title: "主进程的版本" } },
    });
    fireEvent.keyDown(card(), { key: "F2" });
    fireEvent.change(field(), { target: { value: "新名字" } });
    fireEvent.keyDown(field(), { key: "Enter" });
    await waitFor(() =>
      expect(card().querySelector(".session-item__title")?.textContent).toBe(
        "主进程的版本",
      ),
    );
  });

  it("the open session's topic rail takes the topics main answers — the current one renamed (owner 2026-09-30)", async () => {
    const topics = [
      { title: "第一个话题", anchorIndex: 0, anchorText: "hi", at: "t1" },
      { title: "新名字", anchorIndex: 4, anchorText: "later", at: "t2" },
    ];
    await setup({
      sessionActions: { renameResult: { ok: true, title: "新名字", topics } },
    });
    fireEvent.keyDown(card(), { key: "F2" });
    fireEvent.change(field(), { target: { value: "新名字" } });
    fireEvent.keyDown(field(), { key: "Enter" });
    await waitFor(() =>
      expect(screen.getByTestId("topics").textContent).toBe(
        "第一个话题|新名字",
      ),
    );
  });
});

describe("export from the menu (ADR 0072 §3)", () => {
  it("reads the session, saves it under its title, and says 已导出", async () => {
    const mock = await setup({
      sessionActions: {
        exportSource: {
          sessionId: SESSION.sessionId,
          title: "旧名字",
          lang: "zh",
          record: [{ kind: "user", text: "hi" }],
        },
      },
    });
    rightClick();
    fireEvent.click(screen.getByText("导出为 Markdown…"));
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toBe("已导出"),
    );
    expect(mock.calls.readSessionForExport).toEqual([SESSION.sessionId]);
    expect(mock.calls.saveSessionExport[0]?.[0]).toBe("旧名字");
    expect(mock.calls.saveSessionExport[0]?.[1]).toContain("# 旧名字");
    expect(mock.calls.openSession).toEqual([]);
  });

  it("a cancelled save says nothing; a failed one says so", async () => {
    const cancelled = await setup({
      sessionActions: { saveResult: { saved: false } },
    });
    rightClick();
    fireEvent.click(screen.getByText("导出为 Markdown…"));
    await waitFor(() =>
      expect(cancelled.calls.saveSessionExport).toHaveLength(1),
    );
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("a failed save says 导出失败", async () => {
    await setup({
      sessionActions: { saveResult: { saved: false, failed: true } },
    });
    rightClick();
    fireEvent.click(screen.getByText("导出为 Markdown…"));
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toBe("导出失败"),
    );
  });
});
