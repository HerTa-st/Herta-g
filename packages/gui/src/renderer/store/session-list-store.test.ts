import type { SessionMetadata } from "@herta/app-server";
import { describe, expect, it } from "vitest";
import { createMockHertaBridge } from "../ipc/mock-bridge.js";
import { SessionListStore } from "./session-list-store.js";

function meta(id: string): SessionMetadata {
  return {
    sessionId: id,
    workspaceRoot: "/r",
    startedAt: "2026-05-29T00:00:00Z",
    lastActivityAt: "2026-05-29T00:00:00Z",
  };
}

describe("SessionListStore", () => {
  it("loads the session list on connect", async () => {
    const mock = createMockHertaBridge({
      listSessionsResult: [meta("a"), meta("b")],
    });
    const store = new SessionListStore();
    store.connect(mock.bridge);
    await Promise.resolve(); // let the initial listSessions() resolve
    await Promise.resolve();
    expect(store.getSnapshot().map((s) => s.sessionId)).toEqual(["a", "b"]);
  });

  it("refreshes on reset", async () => {
    let result = [meta("a")];
    const mock = createMockHertaBridge();
    // Re-point listSessions to a mutable result.
    (
      mock.bridge as {
        listSessions: () => Promise<readonly SessionMetadata[]>;
      }
    ).listSessions = async () => result;
    const store = new SessionListStore();
    store.connect(mock.bridge);
    await Promise.resolve();
    await Promise.resolve();
    expect(store.getSnapshot()).toHaveLength(1);
    result = [meta("a"), meta("c")];
    mock.emitReset({
      sessionId: "c",
      workspaceRoot: "/r",
      record: [],
      overlay: null,
      backendWorkspace: "/r",
      backendWorkspaceIsDefault: true,
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(store.getSnapshot().map((s) => s.sessionId)).toEqual(["a", "c"]);
  });

  it("a tombstoned id is filtered from refreshes, then cleared when a reset re-names it (web bug 2026-07-10)", async () => {
    let result = [meta("live")];
    const mock = createMockHertaBridge();
    (
      mock.bridge as {
        listSessions: () => Promise<readonly SessionMetadata[]>;
      }
    ).listSessions = async () => result;
    const store = new SessionListStore();
    store.connect(mock.bridge);
    await Promise.resolve();
    await Promise.resolve();
    expect(store.getSnapshot().map((s) => s.sessionId)).toEqual(["live"]);

    // Delete: the card drops optimistically AND the id is tombstoned, so a
    // stale in-flight refresh can't resurrect it as a ghost.
    mock.emitSessionDeleted({ sessionId: "live" });
    expect(store.getSnapshot()).toHaveLength(0);
    mock.emitReset({
      sessionId: "other",
      workspaceRoot: "/r",
      record: [],
      overlay: null,
      backendWorkspace: "/r",
      backendWorkspaceIsDefault: true,
    });
    await Promise.resolve();
    await Promise.resolve();
    // The disk still listed it (snapshot raced the delete) — filtered.
    expect(store.getSnapshot().map((s) => s.sessionId)).toEqual([]);

    // RE-CREATION with the same id (the website demo bridge's fixed
    // LIVE_ID; app UUIDs never recur): the reset naming it is authoritative
    // proof of existence — the tombstone clears and the card returns.
    result = [meta("live")];
    mock.emitReset({
      sessionId: "live",
      workspaceRoot: "/r",
      record: [],
      overlay: null,
      backendWorkspace: "/r",
      backendWorkspaceIsDefault: true,
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(store.getSnapshot().map((s) => s.sessionId)).toEqual(["live"]);
  });

  it("a slower OLDER refresh cannot overwrite a newer one (sequence guard)", async () => {
    const mock = createMockHertaBridge();
    // Two controllable in-flight listSessions calls: the FIRST (older) resolves
    // LAST — without the sequence guard its stale list would win.
    const resolvers: Array<(v: readonly SessionMetadata[]) => void> = [];
    (
      mock.bridge as {
        listSessions: () => Promise<readonly SessionMetadata[]>;
      }
    ).listSessions = () =>
      new Promise((resolve) => {
        resolvers.push(resolve);
      });
    const store = new SessionListStore();
    store.connect(mock.bridge); // refresh #1 (connect)
    mock.emitReset({
      sessionId: "x",
      workspaceRoot: "/r",
      record: [],
      overlay: null,
      backendWorkspace: "/r",
      backendWorkspaceIsDefault: true,
    }); // refresh #2
    expect(resolvers).toHaveLength(2);
    // Newer refresh resolves first with the fresh list…
    resolvers[1]?.([meta("fresh-a"), meta("fresh-b")]);
    await Promise.resolve();
    await Promise.resolve();
    expect(store.getSnapshot().map((s) => s.sessionId)).toEqual([
      "fresh-a",
      "fresh-b",
    ]);
    // …then the OLDER one resolves late with a stale list — it must be ignored.
    resolvers[0]?.([meta("stale")]);
    await Promise.resolve();
    await Promise.resolve();
    expect(store.getSnapshot().map((s) => s.sessionId)).toEqual([
      "fresh-a",
      "fresh-b",
    ]);
  });

  it("getSnapshot is referentially stable between changes", async () => {
    const mock = createMockHertaBridge({ listSessionsResult: [] });
    const store = new SessionListStore();
    store.connect(mock.bridge);
    const a = store.getSnapshot();
    expect(store.getSnapshot()).toBe(a);
    store.dispose();
  });

  it("a title event updates the matching entry and exposes liveTitle", async () => {
    const mock = createMockHertaBridge({
      listSessionsResult: [meta("a"), meta("b")],
    });
    const store = new SessionListStore();
    store.connect(mock.bridge);
    await Promise.resolve();
    await Promise.resolve();
    expect(store.getLiveTitleSnapshot()).toBeNull();

    mock.emitTitle({ kind: "title", sessionId: "b", title: "排查失踪引用" });

    expect(store.getSnapshot().find((s) => s.sessionId === "b")?.title).toBe(
      "排查失踪引用",
    );
    expect(store.getSnapshot().find((s) => s.sessionId === "a")?.title).toBe(
      undefined,
    );
    expect(store.getLiveTitleSnapshot()).toEqual({
      sessionId: "b",
      title: "排查失踪引用",
    });
    store.dispose();
  });

  it("settling the live title ends it for that session only, and keeps the title", async () => {
    const mock = createMockHertaBridge({
      listSessionsResult: [meta("a"), meta("b")],
    });
    const store = new SessionListStore();
    store.connect(mock.bridge);
    await Promise.resolve();
    await Promise.resolve();
    let notified = 0;
    store.subscribe(() => {
      notified += 1;
    });

    mock.emitTitle({ kind: "title", sessionId: "b", title: "排查失踪引用" });
    notified = 0;
    // Another card cannot settle b's title.
    store.settleLiveTitle("a");
    expect(store.getLiveTitleSnapshot()?.sessionId).toBe("b");
    expect(notified).toBe(0);

    store.settleLiveTitle("b");
    expect(store.getLiveTitleSnapshot()).toBeNull();
    expect(notified).toBe(1);
    expect(store.getSnapshot().find((s) => s.sessionId === "b")?.title).toBe(
      "排查失踪引用",
    );
    store.dispose();
  });

  it("drops the matching card when a session is deleted", async () => {
    const mock = createMockHertaBridge({
      listSessionsResult: [meta("a"), meta("b")],
    });
    const store = new SessionListStore();
    store.connect(mock.bridge);
    await Promise.resolve();
    await Promise.resolve();
    mock.emitSessionDeleted({ sessionId: "a" });
    expect(store.getSnapshot().map((s) => s.sessionId)).toEqual(["b"]);
    store.dispose();
  });

  it("bumps the active session to the head with fresh lastActivityAt on a user message", async () => {
    // The sidebar buckets by lastActivityAt (disk mtime) and preserves list
    // order — without a live bump, a reactivated old session keeps its stale
    // bucket ("Yesterday") even as its preview updates (user 2026-06-13).
    const old = {
      ...meta("old"),
      lastActivityAt: "2026-05-20T00:00:00Z",
    };
    const mock = createMockHertaBridge({
      listSessionsResult: [meta("a"), meta("b"), old],
    });
    const store = new SessionListStore();
    store.connect(mock.bridge);
    await Promise.resolve();
    await Promise.resolve();

    mock.emitReset({
      sessionId: "old",
      workspaceRoot: "/r",
      record: [],
      overlay: null,
      backendWorkspace: "/r",
      backendWorkspaceIsDefault: true,
    });
    const before = Date.now();
    mock.emitRecord({
      kind: "block",
      blockId: "b1",
      block: { kind: "user", text: "新消息" },
    });
    const list = store.getSnapshot();
    // Moved to the head (the newest-activity position)…
    expect(list.map((s) => s.sessionId)).toEqual(["old", "a", "b"]);
    // …with a now-ish lastActivityAt so grouping buckets it into Today.
    const bumped = Date.parse(list[0]?.lastActivityAt ?? "");
    expect(bumped).toBeGreaterThanOrEqual(before);
    expect(bumped).toBeLessThanOrEqual(Date.now());
    store.dispose();
  });

  it("clears the active pointer on a no-session reset", async () => {
    const mock = createMockHertaBridge({
      listSessionsResult: [meta("a"), meta("b")],
    });
    const store = new SessionListStore();
    store.connect(mock.bridge);
    await Promise.resolve();
    await Promise.resolve();

    // Activate session "a".
    mock.emitReset({
      sessionId: "a",
      workspaceRoot: "/r",
      record: [],
      overlay: null,
      backendWorkspace: "/r",
      backendWorkspaceIsDefault: true,
    });
    await Promise.resolve();
    await Promise.resolve();

    // Now emit a no-session reset — the active pointer must clear.
    mock.emitReset({ noSession: true });
    await Promise.resolve();
    await Promise.resolve();

    // A user record after a no-session reset must not update any session's
    // lastUserText (proves activeSessionId is now null).
    mock.emitRecord({
      kind: "block",
      blockId: "b1",
      block: { kind: "user", text: "should not land" },
    });
    expect(
      store.getSnapshot().find((s) => s.sessionId === "a")?.lastUserText,
    ).toBeUndefined();
    store.dispose();
  });

  it("keeps the active session's lastUserText current from the record stream", async () => {
    const mock = createMockHertaBridge({
      listSessionsResult: [meta("a"), meta("b")],
    });
    const store = new SessionListStore();
    store.connect(mock.bridge);
    await Promise.resolve();
    await Promise.resolve();

    // Activate "a", then send a user message — its lastUserText updates
    // synchronously (no wait for a disk refresh).
    mock.emitReset({
      sessionId: "a",
      workspaceRoot: "/r",
      record: [],
      overlay: null,
      backendWorkspace: "/r",
      backendWorkspaceIsDefault: true,
    });
    mock.emitRecord({
      kind: "block",
      blockId: "b1",
      block: { kind: "user", text: "latest thing I said" },
    });
    expect(
      store.getSnapshot().find((s) => s.sessionId === "a")?.lastUserText,
    ).toBe("latest thing I said");
    // A non-active session is untouched.
    expect(
      store.getSnapshot().find((s) => s.sessionId === "b")?.lastUserText,
    ).toBeUndefined();
    store.dispose();
  });

  it("a record RESET (rewind) re-reads disk, dropping the withdrawn preview", async () => {
    // The bug (user 2026-08-03): send "hi" into an old session, stop it, rewind
    // — the sidebar card kept previewing "hi". `onRecord` wrote it optimistically
    // and nothing on this store's subscriptions fires for a rewind (the SESSION
    // reset channel is a different one), so the withdrawn text never cleared.
    const result: readonly SessionMetadata[] = [
      { ...meta("a"), lastUserText: "第 7 条，记下了。" },
    ];
    const mock = createMockHertaBridge();
    (
      mock.bridge as {
        listSessions: () => Promise<readonly SessionMetadata[]>;
      }
    ).listSessions = async () => result;
    const store = new SessionListStore();
    store.connect(mock.bridge);
    await Promise.resolve();
    await Promise.resolve();

    mock.emitReset({
      sessionId: "a",
      workspaceRoot: "/r",
      record: [],
      overlay: null,
      backendWorkspace: "/r",
      backendWorkspaceIsDefault: true,
    });
    await Promise.resolve();
    await Promise.resolve();
    // The optimistic bump on send.
    mock.emitRecord({
      kind: "block",
      blockId: "b1",
      block: { kind: "user", text: "hi" },
    });
    expect(
      store.getSnapshot().find((s) => s.sessionId === "a")?.lastUserText,
    ).toBe("hi");

    // The rewind: disk no longer holds "hi", and the truncation broadcasts a
    // record-stream reset.
    mock.emitRecord({ kind: "reset", record: [], start: 0 });
    await Promise.resolve();
    await Promise.resolve();
    expect(
      store.getSnapshot().find((s) => s.sessionId === "a")?.lastUserText,
    ).toBe("第 7 条，记下了。");
    store.dispose();
  });
});
