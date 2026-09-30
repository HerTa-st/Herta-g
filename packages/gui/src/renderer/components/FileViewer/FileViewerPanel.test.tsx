import { configure, fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

// The rich renderers are lazy chunks (ADR 0054); under full-suite contention
// the default 1s async timeout is too tight for the first import.
configure({ asyncUtilTimeout: 5000 });

import { createMockHertaBridge } from "../../ipc/mock-bridge.js";
import { renderWithSession } from "../../testing/renderWithSession.js";
import { FileViewerPanel } from "./FileViewerPanel.js";
import {
  FileViewerProvider,
  useFileViewerOpen,
} from "./file-viewer-context.js";

// jsdom has no object URLs; the picture renderer mints one per image.
if (typeof URL.createObjectURL !== "function") {
  URL.createObjectURL = () => "blob:jsdom";
  URL.revokeObjectURL = () => undefined;
}

function Probe(): JSX.Element {
  const open = useFileViewerOpen();
  return (
    <>
      <button
        type="button"
        data-testid="probe"
        data-available={open !== null}
        onClick={() => open?.("src/a.ts")}
      >
        open
      </button>
      <button
        type="button"
        data-testid="probe-png"
        onClick={() => open?.("shots/one.png")}
      >
        open png
      </button>
      <button
        type="button"
        data-testid="probe-md"
        onClick={() => open?.("docs/notes.md")}
      >
        open md
      </button>
      <button
        type="button"
        data-testid="probe-md-anchored"
        onClick={() => open?.("docs/notes.md", { anchor: { from: 1, to: 1 } })}
      >
        open md anchored
      </button>
      <button
        type="button"
        data-testid="probe-b"
        onClick={() => open?.("src/b.ts")}
      >
        open b
      </button>
      <button
        type="button"
        data-testid="probe-anchored"
        onClick={() => open?.("src/a.ts", { anchor: { from: 2, to: 3 } })}
      >
        open anchored
      </button>
      <button
        type="button"
        data-testid="probe-commit"
        onClick={() => open?.("a1b2c3d", { kind: "commit", label: "a1b2c3d" })}
      >
        open commit
      </button>
      <button
        type="button"
        data-testid="probe-diff"
        onClick={() => open?.("src/a.ts", { kind: "diff" })}
      >
        open diff
      </button>
      <button
        type="button"
        data-testid="probe-log"
        onClick={() => open?.("history", { kind: "log", label: "History" })}
      >
        open log
      </button>
      <button
        type="button"
        data-testid="probe-md-diff"
        onClick={() => open?.("docs/notes.md", { kind: "diff" })}
      >
        open md diff
      </button>
    </>
  );
}

function logEntry(i: number, unpushed = false) {
  return {
    sha: `${String(i).padStart(4, "0")}${"a".repeat(36)}`,
    shortSha: `${String(i).padStart(4, "0")}aaa`,
    subject: `step ${i}`,
    author: "Tester",
    authoredAt: "2026-09-07T10:00:00+08:00",
    unpushed,
  };
}

const COMMIT = {
  sha: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
  shortSha: "a1b2c3d",
  subject: "feat: the work",
  body: "A body line.",
  author: "Tester",
  authoredAt: "2026-09-07T10:00:00+08:00",
  parents: ["0000000000000000000000000000000000000000"],
  files: [
    { path: "src/a.ts", status: "modified" as const, added: 1, deleted: 1 },
    { path: "pic.png", status: "added" as const, added: null, deleted: null },
    { path: "gone.ts", status: "deleted" as const, added: 0, deleted: 3 },
  ],
  filesTotal: 3,
  patch: [
    "diff --git a/src/a.ts b/src/a.ts",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -1 +1 @@",
    "-one",
    "+two",
    "diff --git a/pic.png b/pic.png",
    "Binary files /dev/null and b/pic.png differ",
    "diff --git a/gone.ts b/gone.ts",
    "@@ -1,3 +0,0 @@",
    "-x",
    "-y",
    "-z",
    "",
  ].join("\n"),
  patchTruncated: false,
};

function ui(): JSX.Element {
  return (
    <FileViewerProvider>
      <Probe />
      <FileViewerPanel />
    </FileViewerProvider>
  );
}

describe("FileViewerPanel (ADR 0050)", () => {
  it("without the bridge method the opener is null — nothing is clickable", () => {
    const h = renderWithSession(ui());
    h.openSession("s1");
    expect(screen.getByTestId("probe").dataset.available).toBe("false");
  });

  it("opens, reads through the bridge, and shows the file with line numbers", async () => {
    const mock = createMockHertaBridge();
    const readWorkspaceFile = vi.fn(async () => ({
      ok: true as const,
      content: "one\ntwo\n",
      truncated: false,
      size: 8,
      relative: "src/a.ts",
    }));
    Object.assign(mock.bridge, { readWorkspaceFile });
    const h = renderWithSession(ui(), { mock });
    h.openSession("s1");
    expect(screen.getByTestId("probe").dataset.available).toBe("true");
    fireEvent.click(screen.getByTestId("probe"));
    await waitFor(() =>
      expect(screen.getByTestId("file-viewer")).toBeInTheDocument(),
    );
    await waitFor(() =>
      expect(
        screen.getByTestId("file-viewer").querySelector(".file-viewer__text")
          ?.textContent,
      ).toContain("one\ntwo"),
    );
    expect(readWorkspaceFile).toHaveBeenCalledWith("s1", "src/a.ts");
    // The tab chip names the file (v1.5 — the tab strip replaced the crumb).
    expect(
      screen.getByTestId("file-viewer").querySelector(".file-viewer__tab-name")
        ?.textContent,
    ).toBe("a.ts");
  });

  it("a vanished file answers with the honest notice, not a blank panel", async () => {
    const mock = createMockHertaBridge();
    Object.assign(mock.bridge, {
      readWorkspaceFile: vi.fn(async () => ({
        ok: false as const,
        reason: "not_found" as const,
      })),
    });
    const h = renderWithSession(ui(), { mock });
    h.openSession("s1");
    fireEvent.click(screen.getByTestId("probe"));
    await waitFor(() =>
      expect(
        screen.getByTestId("file-viewer").querySelector(".file-viewer__notice")
          ?.textContent,
      ).toContain("no longer exists"),
    );
  });

  it("a commit tab reads the commit and shows the message, the files with counts, and the hunks (ADR 0059)", async () => {
    const mock = createMockHertaBridge();
    const readWorkspaceFile = vi.fn(async () => ({
      ok: false as const,
      reason: "not_found" as const,
    }));
    const readWorkspaceCommit = vi.fn(async () => ({
      ok: true as const,
      commit: COMMIT,
    }));
    Object.assign(mock.bridge, { readWorkspaceFile, readWorkspaceCommit });
    const h = renderWithSession(ui(), { mock });
    h.openSession("s1");
    fireEvent.click(screen.getByTestId("probe-commit"));
    await waitFor(() =>
      expect(screen.getByTestId("file-viewer").getAttribute("data-kind")).toBe(
        "commit",
      ),
    );
    expect(readWorkspaceCommit).toHaveBeenCalledWith("s1", "a1b2c3d");
    expect(readWorkspaceFile).not.toHaveBeenCalled();
    const panel = screen.getByTestId("file-viewer");
    await waitFor(() =>
      expect(panel.querySelector(".commit-view__subject")?.textContent).toBe(
        "feat: the work",
      ),
    );
    expect(panel.querySelector(".commit-view__message")?.textContent).toBe(
      "A body line.",
    );
    expect(panel.querySelector(".commit-view__meta")?.textContent).toContain(
      "Tester",
    );
    expect(panel.querySelector(".commit-view__stat")?.textContent).toBe(
      "3 files+1 −4",
    );
    const files = panel.querySelectorAll(".commit-view__file");
    expect(files).toHaveLength(3);
    // A modified file inside the workspace opens live; a binary says so; a
    // deleted file has nothing live to open.
    expect(files[0]?.querySelector("button.commit-view__path")).not.toBeNull();
    expect(files[0]?.querySelector(".commit-view__counts")?.textContent).toBe(
      "+1 −1",
    );
    expect(files[0]?.querySelectorAll(".diff-body__line.is-add")).toHaveLength(
      1,
    );
    expect(files[1]?.querySelector(".commit-view__counts")?.textContent).toBe(
      "binary",
    );
    expect(files[1]?.querySelector(".diff-body__line.is-meta")).not.toBeNull();
    expect(files[2]?.querySelector("button.commit-view__path")).toBeNull();
    expect(files[2]?.querySelectorAll(".diff-body__line.is-del")).toHaveLength(
      3,
    );
    // The tab is named by the short sha; no "open externally" for a commit.
    expect(panel.querySelector(".file-viewer__tab-name")?.textContent).toBe(
      "a1b2c3d",
    );
    expect(
      panel.querySelector('[aria-label="Open in default app"]'),
    ).toBeNull();
    // Clicking the file opens it as a FILE tab beside the commit tab.
    fireEvent.click(
      files[0]?.querySelector("button.commit-view__path") as Element,
    );
    await waitFor(() =>
      expect(readWorkspaceFile).toHaveBeenCalledWith("s1", "src/a.ts"),
    );
    expect(panel.querySelectorAll(".file-viewer__tab")).toHaveLength(2);
  });

  it("a diff tab shows the path's change against HEAD beside a file tab for the same path (ADR 0059 §5)", async () => {
    const mock = createMockHertaBridge();
    const readWorkspaceFile = vi.fn(async () => ({
      ok: true as const,
      content: "one\ntwo\n",
      truncated: false,
      size: 8,
      relative: "src/a.ts",
    }));
    const readWorkspaceDiff = vi.fn(async () => ({
      ok: true as const,
      diff: {
        path: "src/a.ts",
        untracked: false,
        missing: false,
        patch:
          "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,2 +1,2 @@\n one\n-two\n+three\n",
        patchTruncated: false,
        added: 1,
        deleted: 1,
      },
    }));
    Object.assign(mock.bridge, { readWorkspaceFile, readWorkspaceDiff });
    const h = renderWithSession(ui(), { mock });
    h.openSession("s1");
    fireEvent.click(screen.getByTestId("probe-diff"));
    await waitFor(() =>
      expect(screen.getByTestId("file-viewer").getAttribute("data-kind")).toBe(
        "diff",
      ),
    );
    expect(readWorkspaceDiff).toHaveBeenCalledWith("s1", "src/a.ts");
    const panel = screen.getByTestId("file-viewer");
    await waitFor(() =>
      expect(panel.querySelector(".diff-view")).not.toBeNull(),
    );
    expect(panel.querySelector(".file-viewer__tab-name")?.textContent).toBe(
      "± a.ts",
    );
    expect(panel.querySelector(".commit-view__meta")?.textContent).toBe(
      "Changes against HEAD",
    );
    expect(panel.querySelector(".commit-view__counts")?.textContent).toBe(
      "+1 −1",
    );
    expect(panel.querySelectorAll(".diff-body__line.is-add")).toHaveLength(1);
    expect(panel.querySelectorAll(".diff-body__line.is-del")).toHaveLength(1);
    // The header's path opens the LIVE file as its own tab; both stay open.
    fireEvent.click(panel.querySelector("button.commit-view__path") as Element);
    await waitFor(() =>
      expect(readWorkspaceFile).toHaveBeenCalledWith("s1", "src/a.ts"),
    );
    expect(panel.querySelectorAll(".file-viewer__tab")).toHaveLength(2);
    expect(
      [...panel.querySelectorAll(".file-viewer__tab-name")].map(
        (t) => t.textContent,
      ),
    ).toEqual(["± a.ts", "a.ts"]);
  });

  it("a diff for an untracked file says so; no change says so; an outside path is refused", async () => {
    const mock = createMockHertaBridge();
    let reply: unknown = {
      ok: true,
      diff: {
        path: "src/a.ts",
        untracked: true,
        missing: false,
        patch: "",
        patchTruncated: false,
        added: 0,
        deleted: 0,
      },
    };
    Object.assign(mock.bridge, {
      readWorkspaceFile: vi.fn(async () => ({
        ok: false as const,
        reason: "not_found" as const,
      })),
      readWorkspaceDiff: vi.fn(async () => reply),
    });
    const h = renderWithSession(ui(), { mock });
    h.openSession("s1");
    fireEvent.click(screen.getByTestId("probe-diff"));
    const panel = await screen.findByTestId("file-viewer");
    await waitFor(() =>
      expect(panel.querySelector(".commit-view__meta")?.textContent).toContain(
        "Untracked",
      ),
    );
    expect(panel.querySelector(".file-viewer__notice")?.textContent).toBe(
      "No changes against HEAD",
    );
    reply = { ok: false, reason: "outside_workspace" };
    h.openSession("s2");
    fireEvent.click(screen.getByTestId("probe-diff"));
    await waitFor(() =>
      expect(
        screen.getByTestId("file-viewer").querySelector(".file-viewer__notice")
          ?.textContent,
      ).toBe("This path is outside the workspace"),
    );
  });

  it("the history tab pages the log, marks unpushed commits, loads more, and opens a commit (ADR 0059 §6)", async () => {
    const mock = createMockHertaBridge();
    const readWorkspaceLog = vi.fn(
      async (_s: string, opts: { readonly skip: number }) => ({
        ok: true as const,
        page:
          opts.skip === 0
            ? {
                entries: [logEntry(1, true), logEntry(2)],
                skip: 0,
                hasMore: true,
                upstream: "origin/main",
                upstreamGone: false,
              }
            : {
                entries: [logEntry(3)],
                skip: opts.skip,
                hasMore: false,
                upstream: "origin/main",
                upstreamGone: false,
              },
      }),
    );
    const readWorkspaceCommit = vi.fn(async () => ({
      ok: false as const,
      reason: "not_found" as const,
    }));
    Object.assign(mock.bridge, {
      readWorkspaceFile: vi.fn(async () => ({
        ok: false as const,
        reason: "not_found" as const,
      })),
      readWorkspaceLog,
      readWorkspaceCommit,
    });
    const h = renderWithSession(ui(), { mock });
    h.openSession("s1");
    fireEvent.click(screen.getByTestId("probe-log"));
    const panel = await screen.findByTestId("file-viewer");
    expect(panel.getAttribute("data-kind")).toBe("log");
    expect(panel.querySelector(".file-viewer__tab-name")?.textContent).toBe(
      "History",
    );
    // No copy, no external open for history — only close.
    expect(panel.querySelectorAll(".file-viewer__action")).toHaveLength(1);
    await waitFor(() =>
      expect(panel.querySelectorAll(".log-view__row")).toHaveLength(2),
    );
    expect(readWorkspaceLog).toHaveBeenCalledWith("s1", { skip: 0, limit: 50 });
    const rows = panel.querySelectorAll(".log-view__row");
    expect(rows[0]?.classList.contains("is-unpushed")).toBe(true);
    expect(rows[1]?.classList.contains("is-unpushed")).toBe(false);
    expect(rows[0]?.querySelector(".log-view__subject")?.textContent).toBe(
      "step 1",
    );
    expect(panel.querySelector(".commit-view__meta")?.textContent).toContain(
      "origin/main",
    );
    // Load more appends the next page from where the list ends.
    fireEvent.click(panel.querySelector(".log-view__more") as Element);
    await waitFor(() =>
      expect(readWorkspaceLog).toHaveBeenCalledWith("s1", {
        skip: 2,
        limit: 50,
      }),
    );
    await waitFor(() =>
      expect(panel.querySelectorAll(".log-view__row")).toHaveLength(3),
    );
    expect(panel.querySelector(".log-view__more")).toBeNull();
    expect(panel.querySelector(".log-view__end")?.textContent).toBe(
      "Beginning of history",
    );
    // A row opens its commit beside the history.
    fireEvent.click(panel.querySelectorAll(".log-view__commit")[1] as Element);
    await waitFor(() =>
      expect(readWorkspaceCommit).toHaveBeenCalledWith("s1", "0002aaa"),
    );
    expect(panel.querySelectorAll(".file-viewer__tab")).toHaveLength(2);
  });

  it("the history tab's search settles into a message filter, and the branch picker reads another branch without checking out (ADR 0059 §6 amendment)", async () => {
    const mock = createMockHertaBridge();
    const readWorkspaceLog = vi.fn(
      async (
        _s: string,
        opts: {
          readonly skip: number;
          readonly ref?: string;
          readonly query?: string;
        },
      ) => ({
        ok: true as const,
        page: {
          entries:
            opts.query === "zzz"
              ? []
              : opts.ref === "feature/x"
                ? [logEntry(9)]
                : [logEntry(1), logEntry(2)],
          skip: opts.skip,
          hasMore: false,
          upstream: opts.ref === "feature/x" ? null : "origin/main",
        },
      }),
    );
    const readWorkspaceBranches = vi.fn(async () => ({
      ok: true as const,
      branches: {
        current: "main",
        branches: [
          {
            name: "main",
            kind: "local" as const,
            upstream: "origin/main",
            upstreamGone: false,
            current: true,
          },
          {
            name: "feature/x",
            kind: "local" as const,
            upstream: null,
            upstreamGone: false,
            current: false,
          },
          {
            name: "origin/main",
            kind: "remote" as const,
            upstream: null,
            upstreamGone: false,
            current: false,
          },
        ],
      },
    }));
    Object.assign(mock.bridge, {
      readWorkspaceFile: vi.fn(async () => ({
        ok: false as const,
        reason: "not_found" as const,
      })),
      readWorkspaceLog,
      readWorkspaceBranches,
    });
    const h = renderWithSession(ui(), { mock });
    h.openSession("s1");
    fireEvent.click(screen.getByTestId("probe-log"));
    const panel = await screen.findByTestId("file-viewer");
    await waitFor(() =>
      expect(panel.querySelectorAll(".log-view__row")).toHaveLength(2),
    );
    // The picker names HEAD's branch and lists the others. (By role: the
    // Select labels its trigger AND its open list with the same name.)
    const picker = await screen.findByRole("button", { name: "Branch" });
    expect(picker.textContent).toContain("main");
    // Typing settles into a query after the debounce; nothing matches.
    const search = screen.getByLabelText("Search commit messages");
    fireEvent.change(search, { target: { value: "zzz" } });
    await waitFor(() =>
      expect(readWorkspaceLog).toHaveBeenCalledWith("s1", {
        skip: 0,
        limit: 50,
        query: "zzz",
      }),
    );
    await waitFor(() =>
      expect(panel.querySelector(".file-viewer__notice")?.textContent).toBe(
        "No matching commits",
      ),
    );
    fireEvent.change(search, { target: { value: "" } });
    await waitFor(() =>
      expect(panel.querySelectorAll(".log-view__row")).toHaveLength(2),
    );
    // Picking a branch reads ITS history; the marks follow its upstream.
    fireEvent.click(picker);
    fireEvent.click(screen.getByRole("option", { name: "feature/x" }));
    await waitFor(() =>
      expect(readWorkspaceLog).toHaveBeenCalledWith("s1", {
        skip: 0,
        limit: 50,
        ref: "feature/x",
      }),
    );
    await waitFor(() =>
      expect(panel.querySelector(".log-view__subject")?.textContent).toBe(
        "step 9",
      ),
    );
    expect(panel.querySelector(".commit-view__meta")).toBeNull();
    // Picking HEAD's own branch again asks for HEAD, not a named ref.
    fireEvent.click(screen.getByRole("button", { name: "Branch" }));
    fireEvent.click(screen.getByRole("option", { name: "main" }));
    await waitFor(() =>
      expect(readWorkspaceLog).toHaveBeenLastCalledWith("s1", {
        skip: 0,
        limit: 50,
      }),
    );
  });

  it("a commit git cannot show — or a bridge without the read — answers with the commit notice", async () => {
    const mock = createMockHertaBridge();
    Object.assign(mock.bridge, {
      readWorkspaceFile: vi.fn(async () => ({
        ok: false as const,
        reason: "not_found" as const,
      })),
    });
    const h = renderWithSession(ui(), { mock });
    h.openSession("s1");
    fireEvent.click(screen.getByTestId("probe-commit"));
    await waitFor(() =>
      expect(
        screen.getByTestId("file-viewer").querySelector(".file-viewer__notice")
          ?.textContent,
      ).toBe("This commit could not be read"),
    );
  });

  it("tabs: two opens make two chips, activate swaps, × closes one (ADR 0050 v1.5)", async () => {
    const mock = createMockHertaBridge();
    Object.assign(mock.bridge, {
      readWorkspaceFile: vi.fn(async (_sid: string, p: string) => ({
        ok: true as const,
        content: `content of ${p}\n`,
        truncated: false,
        size: 10,
        relative: p,
      })),
    });
    const h = renderWithSession(ui(), { mock });
    h.openSession("s1");
    fireEvent.click(screen.getByTestId("probe"));
    await waitFor(() =>
      expect(screen.getByTestId("file-viewer")).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByTestId("probe-b"));
    await waitFor(() =>
      expect(
        screen.getByTestId("file-viewer").querySelectorAll(".file-viewer__tab")
          .length,
      ).toBe(2),
    );
    // The newest tab is active and shown.
    await waitFor(() =>
      expect(
        screen.getByTestId("file-viewer").querySelector(".file-viewer__text")
          ?.textContent,
      ).toContain("content of src/b.ts"),
    );
    // Re-opening an open path activates its tab instead of duplicating.
    fireEvent.click(screen.getByTestId("probe"));
    await waitFor(() =>
      expect(
        screen.getByTestId("file-viewer").querySelector(".file-viewer__text")
          ?.textContent,
      ).toContain("content of src/a.ts"),
    );
    expect(
      screen.getByTestId("file-viewer").querySelectorAll(".file-viewer__tab")
        .length,
    ).toBe(2);
    // Clicking the other chip swaps back.
    const chips = screen
      .getByTestId("file-viewer")
      .querySelectorAll(".file-viewer__tab-name");
    fireEvent.click(chips[1] as Element);
    await waitFor(() =>
      expect(
        screen.getByTestId("file-viewer").querySelector(".file-viewer__text")
          ?.textContent,
      ).toContain("content of src/b.ts"),
    );
    // × on the active chip closes it; the other remains shown.
    const xs = screen
      .getByTestId("file-viewer")
      .querySelectorAll(".file-viewer__tab-x");
    fireEvent.click(xs[1] as Element);
    await waitFor(() =>
      expect(
        screen.getByTestId("file-viewer").querySelectorAll(".file-viewer__tab")
          .length,
      ).toBe(1),
    );
    await waitFor(() =>
      expect(
        screen.getByTestId("file-viewer").querySelector(".file-viewer__text")
          ?.textContent,
      ).toContain("content of src/a.ts"),
    );
  });

  it("a cite anchor renders the highlight band over the cited lines", async () => {
    const mock = createMockHertaBridge();
    Object.assign(mock.bridge, {
      readWorkspaceFile: vi.fn(async () => ({
        ok: true as const,
        content: "l1\nl2\nl3\nl4\n",
        truncated: false,
        size: 12,
        relative: "src/a.ts",
      })),
    });
    const h = renderWithSession(ui(), { mock });
    h.openSession("s1");
    fireEvent.click(screen.getByTestId("probe-anchored"));
    await waitFor(() =>
      expect(
        screen.getByTestId("file-viewer").querySelector(".file-viewer__anchor"),
      ).not.toBeNull(),
    );
    const band = screen
      .getByTestId("file-viewer")
      .querySelector(".file-viewer__anchor") as HTMLElement;
    // Lines 2-3 at the jsdom fallback line height (19.2px): one line down,
    // two lines tall.
    expect(Number.parseFloat(band.style.top)).toBeCloseTo(19.2, 1);
    expect(Number.parseFloat(band.style.height)).toBeCloseTo(38.4, 1);
  });

  it("Escape closes; a session SWITCH closes too (the transient-state boundary)", async () => {
    const mock = createMockHertaBridge();
    Object.assign(mock.bridge, {
      readWorkspaceFile: vi.fn(async () => ({
        ok: true as const,
        content: "x",
        truncated: false,
        size: 1,
        relative: "a.txt",
      })),
    });
    const h = renderWithSession(ui(), { mock });
    h.openSession("s1");
    fireEvent.click(screen.getByTestId("probe"));
    await waitFor(() =>
      expect(screen.getByTestId("file-viewer")).toBeInTheDocument(),
    );
    fireEvent.keyDown(screen.getByTestId("file-viewer"), { key: "Escape" });
    expect(screen.queryByTestId("file-viewer")).toBeNull();

    fireEvent.click(screen.getByTestId("probe"));
    await waitFor(() =>
      expect(screen.getByTestId("file-viewer")).toBeInTheDocument(),
    );
    h.switchSession("s2");
    expect(screen.queryByTestId("file-viewer")).toBeNull();
  });
});

describe("FileViewerPanel — UX review 2026-09-22", () => {
  it("a re-cite of an open file RE-READS it, keeping the old content on screen until the new read answers (item 9)", async () => {
    const mock = createMockHertaBridge();
    let version = "before the write";
    const readWorkspaceFile = vi.fn(async () => ({
      ok: true as const,
      content: version,
      truncated: false,
      size: version.length,
      relative: "src/a.ts",
    }));
    Object.assign(mock.bridge, { readWorkspaceFile });
    const h = renderWithSession(ui(), { mock });
    h.openSession("s1");
    fireEvent.click(screen.getByTestId("probe"));
    const panel = await screen.findByTestId("file-viewer");
    await waitFor(() =>
      expect(panel.querySelector(".file-viewer__text")?.textContent).toContain(
        "before the write",
      ),
    );
    // 板砖 writes the file and cites it again.
    version = "after the write";
    fireEvent.click(screen.getByTestId("probe-anchored"));
    // No empty flash: the old text stays until the read answers.
    expect(panel.querySelector(".file-viewer__text")).not.toBeNull();
    await waitFor(() =>
      expect(panel.querySelector(".file-viewer__text")?.textContent).toContain(
        "after the write",
      ),
    );
    expect(readWorkspaceFile).toHaveBeenCalledTimes(2);
  });

  it("Escape in the history search clears it, then hands focus to the panel — it never closes the viewer from the field (item 18)", async () => {
    const mock = createMockHertaBridge();
    Object.assign(mock.bridge, {
      readWorkspaceFile: vi.fn(async () => ({
        ok: false as const,
        reason: "not_found" as const,
      })),
      readWorkspaceLog: vi.fn(async (_s: string, opts: { skip: number }) => ({
        ok: true as const,
        page: {
          entries: [logEntry(1)],
          skip: opts.skip,
          hasMore: false,
          upstream: null,
        },
      })),
    });
    const h = renderWithSession(ui(), { mock });
    h.openSession("s1");
    fireEvent.click(screen.getByTestId("probe-log"));
    const panel = await screen.findByTestId("file-viewer");
    const search = screen.getByLabelText(
      "Search commit messages",
    ) as HTMLInputElement;
    search.focus();
    fireEvent.change(search, { target: { value: "fix" } });
    fireEvent.keyDown(search, { key: "Escape" });
    expect(screen.queryByTestId("file-viewer")).not.toBeNull();
    expect(search.value).toBe("");
    // Empty now: the next Escape moves focus to the panel, still open…
    fireEvent.keyDown(search, { key: "Escape" });
    expect(screen.queryByTestId("file-viewer")).not.toBeNull();
    expect(document.activeElement).toBe(panel);
    // …and the panel's own Escape closes it.
    fireEvent.keyDown(panel, { key: "Escape" });
    expect(screen.queryByTestId("file-viewer")).toBeNull();
  });

  it("mid-composition (Pinyin), Escape cancels the candidate and nothing else — the typed search stays (2026-09-23)", async () => {
    const mock = createMockHertaBridge();
    Object.assign(mock.bridge, {
      readWorkspaceFile: vi.fn(async () => ({
        ok: false as const,
        reason: "not_found" as const,
      })),
      readWorkspaceLog: vi.fn(async (_s: string, opts: { skip: number }) => ({
        ok: true as const,
        page: {
          entries: [logEntry(1)],
          skip: opts.skip,
          hasMore: false,
          upstream: null,
        },
      })),
    });
    const h = renderWithSession(ui(), { mock });
    h.openSession("s1");
    fireEvent.click(screen.getByTestId("probe-log"));
    await screen.findByTestId("file-viewer");
    const search = screen.getByLabelText(
      "Search commit messages",
    ) as HTMLInputElement;
    search.focus();
    fireEvent.change(search, { target: { value: "修复 xiu" } });
    fireEvent.keyDown(search, { key: "Escape", isComposing: true });
    fireEvent.keyDown(search, { key: "Escape", keyCode: 229 });
    expect(search.value).toBe("修复 xiu");
    expect(document.activeElement).toBe(search);
    expect(screen.queryByTestId("file-viewer")).not.toBeNull();
  });

  it("a file tab and its diff tab are two tabs: the Markdown source toggle survives opening the diff (item 19)", async () => {
    const mock = createMockHertaBridge();
    Object.assign(mock.bridge, {
      readWorkspaceFile: vi.fn(async () => ({
        ok: true as const,
        content: "# Notes\n\nbody\n",
        truncated: false,
        size: 14,
        relative: "docs/notes.md",
      })),
      readWorkspaceDiff: vi.fn(async () => ({
        ok: true as const,
        diff: {
          path: "docs/notes.md",
          untracked: false,
          missing: false,
          patch:
            "diff --git a/docs/notes.md b/docs/notes.md\n@@ -1 +1 @@\n-a\n+b\n",
          patchTruncated: false,
          added: 1,
          deleted: 1,
        },
      })),
    });
    const h = renderWithSession(ui(), { mock });
    h.openSession("s1");
    fireEvent.click(screen.getByTestId("probe-md"));
    await screen.findByTestId("file-viewer");
    // Rendered by default; switch this tab to the source.
    fireEvent.click(await screen.findByTestId("viewer-toggle-source"));
    expect(
      screen.getByTestId("viewer-toggle-source").getAttribute("aria-pressed"),
    ).toBe("true");
    fireEvent.click(screen.getByTestId("probe-md-diff"));
    const tabs = await waitFor(() => {
      const t = screen.getAllByRole("tab");
      expect(t).toHaveLength(2);
      return t;
    });
    // Back to the file tab: still the source.
    fireEvent.click(tabs[0] as HTMLElement);
    expect(
      (await screen.findByTestId("viewer-toggle-source")).getAttribute(
        "aria-pressed",
      ),
    ).toBe("true");
  });

  it("the copy tip says Copied for a moment, then reverts on its own (item 21)", async () => {
    const mock = createMockHertaBridge();
    Object.assign(mock.bridge, {
      readWorkspaceFile: vi.fn(async () => ({
        ok: true as const,
        content: "x",
        truncated: false,
        size: 1,
        relative: "src/a.ts",
      })),
    });
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    try {
      const h = renderWithSession(ui(), { mock });
      h.openSession("s1");
      fireEvent.click(screen.getByTestId("probe"));
      await screen.findByTestId("file-viewer");
      const copy = screen.getByRole("button", { name: "Copy path" });
      copy.focus(); // the portal tip opens on focus
      fireEvent.click(copy);
      await waitFor(() =>
        expect(screen.getByRole("tooltip").textContent).toBe("Copied"),
      );
      await waitFor(
        () => expect(screen.getByRole("tooltip").textContent).toBe("Copy path"),
        { timeout: 4000 },
      );
    } finally {
      Reflect.deleteProperty(navigator, "clipboard");
    }
  });

  it("a write the platform refuses says so instead of Copied (2026-09-30)", async () => {
    const mock = createMockHertaBridge();
    Object.assign(mock.bridge, {
      readWorkspaceFile: vi.fn(async () => ({
        ok: true as const,
        content: "x",
        truncated: false,
        size: 1,
        relative: "src/a.ts",
      })),
    });
    const writeText = vi.fn(async () => {
      throw new DOMException("Write permission denied.", "NotAllowedError");
    });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    try {
      const h = renderWithSession(ui(), { mock });
      h.openSession("s1");
      fireEvent.click(screen.getByTestId("probe"));
      await screen.findByTestId("file-viewer");
      const copy = screen.getByRole("button", { name: "Copy path" });
      copy.focus();
      fireEvent.click(copy);
      await waitFor(() =>
        expect(screen.getByRole("tooltip").textContent).toBe("Copy failed"),
      );
    } finally {
      Reflect.deleteProperty(navigator, "clipboard");
    }
  });

  it("closing the viewer hands focus back to what opened it (item 2)", async () => {
    const mock = createMockHertaBridge();
    Object.assign(mock.bridge, {
      readWorkspaceFile: vi.fn(async () => ({
        ok: true as const,
        content: "x",
        truncated: false,
        size: 1,
        relative: "src/a.ts",
      })),
    });
    const h = renderWithSession(ui(), { mock });
    h.openSession("s1");
    const opener = screen.getByTestId("probe");
    opener.focus();
    fireEvent.click(opener);
    const panel = await screen.findByTestId("file-viewer");
    expect(document.activeElement).toBe(panel);
    fireEvent.keyDown(panel, { key: "Escape" });
    expect(screen.queryByTestId("file-viewer")).toBeNull();
    // Not body: an Escape from here is the opener's, never "nobody's".
    expect(document.activeElement).toBe(opener);
  });

  it("neither focus scrolls anything into view — an opener in the parked rail scrolled the whole app 656px (2026-09-24)", async () => {
    const mock = createMockHertaBridge();
    Object.assign(mock.bridge, {
      readWorkspaceFile: vi.fn(async () => ({
        ok: true as const,
        content: "x",
        truncated: false,
        size: 1,
        relative: "src/a.ts",
      })),
    });
    const h = renderWithSession(ui(), { mock });
    h.openSession("s1");
    const opener = screen.getByTestId("probe");
    opener.focus();
    // Spied from here: only the viewer's own calls follow — the panel on
    // open, the opener on close.
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    try {
      fireEvent.click(opener);
      const panel = await screen.findByTestId("file-viewer");
      fireEvent.keyDown(panel, { key: "Escape" });
      expect(document.activeElement).toBe(opener);
      const targets = focus.mock.contexts;
      expect(targets).toContain(panel);
      expect(targets).toContain(opener);
      focus.mock.calls.forEach((args, i) => {
        if (targets[i] === panel || targets[i] === opener) {
          expect(args[0]).toEqual({ preventScroll: true });
        }
      });
    } finally {
      focus.mockRestore();
    }
  });
});

describe("FileViewerPanel — divider drag", () => {
  it("persists the width once, on pointer-up — never per pointer move (2026-09-03)", async () => {
    // localStorage.setItem is a synchronous IPC to the browser process; a
    // precision mouse delivers hundreds of pointer events a second.
    window.localStorage.removeItem("herta.fileViewer.widthPx");
    const mock = createMockHertaBridge();
    Object.assign(mock.bridge, {
      readWorkspaceFile: vi.fn(async () => ({
        ok: true as const,
        content: "x",
        truncated: false,
        size: 1,
        relative: "src/a.ts",
      })),
    });
    const h = renderWithSession(ui(), { mock });
    h.openSession("s1");
    fireEvent.click(screen.getByTestId("probe"));
    await waitFor(() =>
      expect(screen.getByTestId("file-viewer")).toBeInTheDocument(),
    );
    const divider = screen
      .getByTestId("file-viewer")
      .querySelector(".file-viewer__divider") as HTMLElement;
    fireEvent.pointerDown(divider, { clientX: 800, pointerId: 1 });
    fireEvent.pointerMove(window, { clientX: 780 });
    fireEvent.pointerMove(window, { clientX: 760 });
    fireEvent.pointerMove(window, { clientX: 740 });
    expect(window.localStorage.getItem("herta.fileViewer.widthPx")).toBeNull();
    fireEvent.pointerUp(window, { clientX: 740 });
    expect(
      window.localStorage.getItem("herta.fileViewer.widthPx"),
    ).not.toBeNull();
  });
});

describe("FileViewerPanel — the file's kind picks the read and the renderer (ADR 0054)", () => {
  it("a picture takes the BYTES read, not the text read, and draws through <img>", async () => {
    const mock = createMockHertaBridge();
    const readWorkspaceFile = vi.fn(async () => ({
      ok: true as const,
      content: "",
      truncated: false,
      size: 0,
      relative: "x",
    }));
    const readWorkspaceBytes = vi.fn(async () => ({
      ok: true as const,
      bytes: new Uint8Array([137, 80, 78, 71]),
      size: 4,
      relative: "shots/one.png",
    }));
    Object.assign(mock.bridge, { readWorkspaceFile, readWorkspaceBytes });
    const h = renderWithSession(ui(), { mock });
    h.openSession("s1");
    fireEvent.click(screen.getByTestId("probe-png"));
    await waitFor(() =>
      expect(
        screen
          .getByTestId("file-viewer")
          .querySelector("img.file-viewer__image"),
      ).not.toBeNull(),
    );
    expect(readWorkspaceBytes).toHaveBeenCalledWith("s1", "shots/one.png");
    expect(readWorkspaceFile).not.toHaveBeenCalled();
    expect(screen.getByTestId("file-viewer").dataset.kind).toBe("image");
  });

  it("without the bytes read (an older bridge) a picture falls to the text read's binary notice", async () => {
    const mock = createMockHertaBridge();
    Object.assign(mock.bridge, {
      readWorkspaceFile: vi.fn(async () => ({
        ok: false as const,
        reason: "binary" as const,
      })),
    });
    const h = renderWithSession(ui(), { mock });
    h.openSession("s1");
    fireEvent.click(screen.getByTestId("probe-png"));
    await waitFor(() =>
      expect(
        screen.getByTestId("file-viewer").querySelector(".file-viewer__notice")
          ?.textContent,
      ).toContain("Binary file"),
    );
  });

  it("a file over the bytes ceiling answers with the honest notice", async () => {
    const mock = createMockHertaBridge();
    Object.assign(mock.bridge, {
      readWorkspaceFile: vi.fn(),
      readWorkspaceBytes: vi.fn(async () => ({
        ok: false as const,
        reason: "too_large" as const,
      })),
    });
    const h = renderWithSession(ui(), { mock });
    h.openSession("s1");
    fireEvent.click(screen.getByTestId("probe-png"));
    await waitFor(() =>
      expect(
        screen.getByTestId("file-viewer").querySelector(".file-viewer__notice")
          ?.textContent,
      ).toContain("Too large"),
    );
  });

  it("Markdown renders as the page; the header toggle swaps to the source with line numbers and back", async () => {
    const mock = createMockHertaBridge();
    Object.assign(mock.bridge, {
      readWorkspaceFile: vi.fn(async () => ({
        ok: true as const,
        content: "# Hello\n\ntext\n",
        truncated: false,
        size: 14,
        relative: "docs/notes.md",
      })),
    });
    const h = renderWithSession(ui(), { mock });
    h.openSession("s1");
    fireEvent.click(screen.getByTestId("probe-md"));
    const panel = () => screen.getByTestId("file-viewer");
    await waitFor(() =>
      expect(panel().querySelector(".file-viewer__doc h1")?.textContent).toBe(
        "Hello",
      ),
    );
    expect(panel().querySelector(".file-viewer__text")).toBeNull();
    fireEvent.click(screen.getByTestId("viewer-toggle-source"));
    await waitFor(() =>
      expect(
        panel().querySelector(".file-viewer__text")?.textContent,
      ).toContain("# Hello"),
    );
    expect(
      panel().querySelector(".file-viewer__gutter")?.textContent,
    ).toContain("1\n2\n3");
    fireEvent.click(screen.getByTestId("viewer-toggle-source"));
    await waitFor(() =>
      expect(panel().querySelector(".file-viewer__doc h1")).not.toBeNull(),
    );
  });

  it("a cite anchor opens Markdown at the SOURCE (lines are a source concept)", async () => {
    const mock = createMockHertaBridge();
    Object.assign(mock.bridge, {
      readWorkspaceFile: vi.fn(async () => ({
        ok: true as const,
        content: "# Hello\n",
        truncated: false,
        size: 8,
        relative: "docs/notes.md",
      })),
    });
    const h = renderWithSession(ui(), { mock });
    h.openSession("s1");
    fireEvent.click(screen.getByTestId("probe-md-anchored"));
    await waitFor(() =>
      expect(
        screen.getByTestId("file-viewer").querySelector(".file-viewer__anchor"),
      ).not.toBeNull(),
    );
    expect(
      screen.getByTestId("file-viewer").querySelector(".file-viewer__doc"),
    ).toBeNull();
  });

  it("code files keep the gutter layout and gain tokens once the highlighter lands", async () => {
    const mock = createMockHertaBridge();
    Object.assign(mock.bridge, {
      readWorkspaceFile: vi.fn(async () => ({
        ok: true as const,
        content: "const a = 1;\n",
        truncated: false,
        size: 13,
        relative: "src/a.ts",
      })),
    });
    const h = renderWithSession(ui(), { mock });
    h.openSession("s1");
    fireEvent.click(screen.getByTestId("probe"));
    await waitFor(() =>
      expect(
        screen
          .getByTestId("file-viewer")
          .querySelector(".file-viewer__text .hljs-keyword"),
      ).not.toBeNull(),
    );
    expect(
      screen.getByTestId("file-viewer").querySelector(".file-viewer__text")
        ?.textContent,
    ).toBe("const a = 1;\n");
  });
});

describe("FileViewerPanel — a read the clock ended (ADR 0058 §7.7)", () => {
  const TIMEOUT_NOTICE =
    "Timed out reading — the repository is large or git is busy; try again";

  it("a commit tab says the read timed out, not that the commit is missing", async () => {
    const mock = createMockHertaBridge();
    Object.assign(mock.bridge, {
      readWorkspaceFile: vi.fn(async () => ({
        ok: false as const,
        reason: "not_found" as const,
      })),
      readWorkspaceCommit: vi.fn(async () => ({
        ok: false as const,
        reason: "timeout" as const,
      })),
    });
    const h = renderWithSession(ui(), { mock });
    h.openSession("s1");
    fireEvent.click(screen.getByTestId("probe-commit"));
    const panel = await screen.findByTestId("file-viewer");
    await waitFor(() =>
      expect(panel.querySelector(".file-viewer__notice")?.textContent).toBe(
        TIMEOUT_NOTICE,
      ),
    );
  });

  it("a diff tab says the same", async () => {
    const mock = createMockHertaBridge();
    Object.assign(mock.bridge, {
      readWorkspaceFile: vi.fn(async () => ({
        ok: false as const,
        reason: "not_found" as const,
      })),
      readWorkspaceDiff: vi.fn(async () => ({
        ok: false as const,
        reason: "timeout" as const,
      })),
    });
    const h = renderWithSession(ui(), { mock });
    h.openSession("s1");
    fireEvent.click(screen.getByTestId("probe-diff"));
    const panel = await screen.findByTestId("file-viewer");
    await waitFor(() =>
      expect(panel.querySelector(".file-viewer__notice")?.textContent).toBe(
        TIMEOUT_NOTICE,
      ),
    );
  });

  it("the history tab says the same", async () => {
    const mock = createMockHertaBridge();
    Object.assign(mock.bridge, {
      readWorkspaceFile: vi.fn(async () => ({
        ok: false as const,
        reason: "not_found" as const,
      })),
      readWorkspaceLog: vi.fn(async () => ({
        ok: false as const,
        reason: "timeout" as const,
      })),
    });
    const h = renderWithSession(ui(), { mock });
    h.openSession("s1");
    fireEvent.click(screen.getByTestId("probe-log"));
    const panel = await screen.findByTestId("file-viewer");
    await waitFor(() =>
      expect(panel.querySelector(".file-viewer__notice")?.textContent).toBe(
        TIMEOUT_NOTICE,
      ),
    );
  });
});
