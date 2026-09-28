import { describe, expect, it } from "vitest";
import type { ToolCallRequest, ToolResult } from "../types/tool.js";
import type {
  DispatchJournalEntry,
  JournalStartEntry,
} from "./dispatch-journal.js";
import { openDispatch, planSeal, processLine } from "./journal-seal.js";

const ROOT = process.platform === "win32" ? "C:\\ws" : "/ws";
const abs = (rel: string) =>
  process.platform === "win32"
    ? `${ROOT}\\${rel.replaceAll("/", "\\")}`
    : `${ROOT}/${rel}`;

function start(over: Partial<JournalStartEntry> = {}): JournalStartEntry {
  return {
    kind: "start",
    v: 1,
    taskId: "t1",
    at: "2026-09-28T10:00:00.000Z",
    recordLength: 5,
    workspaceRoot: ROOT,
    brief: { taskId: "t1" },
    frame: {
      userMessages: [{ text: "fix it" }],
      omittedUserMessages: 0,
      scopedRepoInstructions: "",
      scopedMemory: "",
      recentDialogue: "",
      workingHistory: "",
      lang: "en",
    },
    ...over,
  };
}

const call = (
  id: string,
  tool: string,
  input: unknown = {},
): ToolCallRequest => ({
  id,
  tool,
  input,
});

const TS = "2026-09-28T10:00:01.000Z";

const asks = (...calls: ToolCallRequest[]): DispatchJournalEntry => ({
  kind: "message",
  message: { role: "assistant", text: "", toolCalls: calls, ts: TS },
});

const answer = (id: string, ok = true): DispatchJournalEntry => ({
  kind: "message",
  message: {
    role: "tool",
    toolCallId: id,
    result: { ok, summary: ok ? "ok" : "failed" },
    ts: TS,
  },
});

const dispatched = (id: string, readOnly = false): DispatchJournalEntry =>
  readOnly
    ? { kind: "dispatch", callIds: [id], readOnly: true }
    : { kind: "dispatch", callIds: [id] };

const wrote = (
  id: string,
  rel: string,
  before: string | null,
  after: string,
): DispatchJournalEntry => ({
  kind: "write",
  callId: id,
  path: abs(rel),
  before,
  after,
});

/** A disk where each path holds the given hash (absent: no file). */
const disk =
  (files: Record<string, string>) =>
  async (path: string): Promise<string | null> =>
    files[path] ?? null;

async function outcomeOf(
  entries: DispatchJournalEntry[],
  files: Record<string, string> = {},
) {
  const plan = await planSeal(entries, disk(files));
  return plan?.calls.map((c) => c.outcome);
}

describe("an open run (ADR 0071 §1.2, the journal's half of the gate)", () => {
  it("is open from its start until an end", () => {
    expect(openDispatch([start()])).toMatchObject({
      segment: 0,
      recordLength: 5,
    });
    expect(
      openDispatch([start(), { kind: "end", status: "completed" }]),
    ).toBeNull();
    expect(openDispatch([])).toBeNull();
    // A journal that lost its start is not a run.
    expect(openDispatch([{ kind: "end", status: "completed" }])).toBeNull();
  });

  it("a continued run is open again from its resume, with the resume's record length", () => {
    const entries: DispatchJournalEntry[] = [
      start(),
      { kind: "end", status: "interrupted", cause: "app-exit" },
      { kind: "resume", at: "x", recordLength: 9 },
    ];
    expect(openDispatch(entries)).toMatchObject({
      segment: 2,
      recordLength: 9,
    });
    expect(
      openDispatch([...entries, { kind: "end", status: "completed" }]),
    ).toBeNull();
  });
});

describe("each open call is decided (ADR 0071 §1.3)", () => {
  it("no dispatch: not started", async () => {
    expect(
      await outcomeOf([
        start(),
        asks(call("c1", "edit_file", { path: "a.ts" })),
      ]),
    ).toEqual(["not_started"]);
  });

  it("dispatched read-only: read interrupted", async () => {
    expect(
      await outcomeOf([
        start(),
        asks(call("c1", "read_file")),
        dispatched("c1", true),
      ]),
    ).toEqual(["read_interrupted"]);
  });

  it("a write whose file holds the after-hash: applied", async () => {
    expect(
      await outcomeOf(
        [
          start(),
          asks(call("c1", "edit_file")),
          dispatched("c1"),
          wrote("c1", "a.ts", "B", "A"),
        ],
        { [abs("a.ts")]: "A" },
      ),
    ).toEqual(["write_applied"]);
  });

  it("a write whose file holds the before-hash, or is still absent: not applied", async () => {
    expect(
      await outcomeOf(
        [
          start(),
          asks(call("c1", "edit_file")),
          dispatched("c1"),
          wrote("c1", "a.ts", "B", "A"),
        ],
        { [abs("a.ts")]: "B" },
      ),
    ).toEqual(["write_not_applied"]);
    expect(
      await outcomeOf([
        start(),
        asks(call("c1", "write_new_file")),
        dispatched("c1"),
        wrote("c1", "new.ts", null, "A"),
      ]),
    ).toEqual(["write_not_applied"]);
  });

  it("a write whose file is neither: changed since", async () => {
    expect(
      await outcomeOf(
        [
          start(),
          asks(call("c1", "edit_file")),
          dispatched("c1"),
          wrote("c1", "a.ts", "B", "A"),
        ],
        { [abs("a.ts")]: "C" },
      ),
    ).toEqual(["write_changed_since"]);
  });

  it("a writer dispatched with no write entry: not applied (the rename only follows the entry)", async () => {
    expect(
      await outcomeOf([
        start(),
        asks(call("c1", "str_replace_editor", { command: "str_replace" })),
        dispatched("c1"),
      ]),
    ).toEqual(["write_not_applied"]);
  });

  it("the editor's view is a read, whatever the tool's flag", async () => {
    expect(
      await outcomeOf([
        start(),
        asks(call("c1", "str_replace_editor", { command: "view" })),
        dispatched("c1"),
      ]),
    ).toEqual(["read_interrupted"]);
  });

  it("todo_write / report_finding: not applied", async () => {
    expect(
      await outcomeOf([
        start(),
        asks(call("c1", "todo_write"), call("c2", "report_finding")),
        dispatched("c1"),
        dispatched("c2"),
      ]),
    ).toEqual(["state_not_applied", "state_not_applied"]);
  });

  it("a command, or anything else with side effects: outcome unknown", async () => {
    expect(
      await outcomeOf([
        start(),
        asks(
          call("c1", "run_command", { command: "npm test" }),
          call("c2", "bash"),
          call("c3", "memory_save"),
        ),
        dispatched("c1"),
        dispatched("c2"),
        dispatched("c3"),
      ]),
    ).toEqual(["outcome_unknown", "outcome_unknown", "outcome_unknown"]);
  });

  it("a file that cannot be read leaves the write's outcome unknown, never a guess", async () => {
    const plan = await planSeal(
      [
        start(),
        asks(call("c1", "edit_file")),
        dispatched("c1"),
        wrote("c1", "a.ts", "B", "A"),
      ],
      async () => {
        throw new Error("EACCES");
      },
    );
    expect(plan?.calls.map((c) => c.outcome)).toEqual(["outcome_unknown"]);
  });

  it("answered calls are not closed again; a closer from a seal cut short is reused, not re-decided", async () => {
    const closed: ToolResult = {
      ok: false,
      summary: "app exited: not started",
    };
    const plan = await planSeal(
      [
        start(),
        asks(
          call("c1", "read_file"),
          call("c2", "edit_file"),
          call("c3", "run_command"),
        ),
        dispatched("c1", true),
        answer("c1"),
        {
          kind: "closer",
          callId: "c2",
          outcome: "not_started",
          result: closed,
        },
      ],
      disk({}),
    );
    expect(plan?.calls.map((c) => [c.callId, c.outcome, c.journaled])).toEqual([
      ["c2", "not_started", true],
      ["c3", "not_started", false],
    ]);
    expect(plan?.calls[0]?.result).toBe(closed);
  });

  it("only the latest segment's calls: a continued run's earlier calls were closed by the first seal", async () => {
    const plan = await planSeal(
      [
        start(),
        asks(call("c1", "run_command")),
        dispatched("c1"),
        {
          kind: "closer",
          callId: "c1",
          outcome: "outcome_unknown",
          result: { ok: false, summary: "x" },
        },
        { kind: "end", status: "interrupted", cause: "app-exit" },
        { kind: "resume", at: "x", recordLength: 9 },
        asks(call("c2", "read_file")),
      ],
      disk({}),
    );
    expect(plan?.calls.map((c) => c.callId)).toEqual(["c2"]);
    expect(plan?.recordLength).toBe(9);
  });
});

describe("what the seal reports", () => {
  it("changed files: finished writes and open writes found applied, workspace-relative, once each", async () => {
    const plan = await planSeal(
      [
        start(),
        asks(
          call("c1", "edit_file"),
          call("c2", "edit_file"),
          call("c3", "edit_file"),
          call("c4", "edit_file"),
        ),
        dispatched("c1"),
        wrote("c1", "src/a.ts", "B", "A"),
        answer("c1"),
        dispatched("c2"),
        wrote("c2", "src/b.ts", "B", "A"),
        answer("c2", false),
        dispatched("c3"),
        wrote("c3", "src/a.ts", "A", "A2"),
        dispatched("c4"),
        wrote("c4", "src/c.ts", "B", "A"),
      ],
      disk({ [abs("src/a.ts")]: "A2", [abs("src/c.ts")]: "B" }),
    );
    expect(plan?.changedFiles).toEqual(["src/a.ts"]);
    expect(plan?.calls.map((c) => [c.step, c.outcome])).toEqual([
      ["edit_file src/a.ts", "write_applied"],
      ["edit_file src/c.ts", "write_not_applied"],
    ]);
  });

  it("the steps name the tool and its target", async () => {
    const plan = await planSeal(
      [
        start(),
        asks(
          call("c1", "run_command", { command: "npm   run\n dev" }),
          call("c2", "read_file", { path: "README.md" }),
          call("c3", "todo_write", { todos: [] }),
        ),
      ],
      disk({}),
    );
    expect(plan?.calls.map((c) => c.step)).toEqual([
      "run_command npm run dev",
      "read_file README.md",
      "todo_write",
    ]);
  });

  it("the open todos come from the last todo list that took effect", async () => {
    const list = (items: Array<[string, string]>) => ({
      todos: items.map(([content, status]) => ({ content, status })),
    });
    const plan = await planSeal(
      [
        start(),
        asks(
          call(
            "t1",
            "todo_write",
            list([
              ["a", "in_progress"],
              ["b", "pending"],
            ]),
          ),
        ),
        answer("t1"),
        asks(
          call(
            "t2",
            "todo_write",
            list([
              ["a", "completed"],
              ["b", "in_progress"],
            ]),
          ),
        ),
        answer("t2"),
        asks(
          call(
            "t3",
            "todo_write",
            list([
              ["a", "completed"],
              ["b", "completed"],
            ]),
          ),
        ),
        answer("t3", false),
      ],
      disk({}),
    );
    expect(plan?.openTodos).toEqual(["b"]);
  });

  it("processes: those with no exit, with a relaunch's finding when there is one, on their call's closer", async () => {
    const plan = await planSeal(
      [
        start(),
        asks(call("c1", "run_command", { command: "npm run dev" })),
        dispatched("c1"),
        {
          kind: "spawn",
          callId: "c1",
          pid: 11,
          startedAt: 1,
          command: "npm run dev",
          role: "background",
        },
        {
          kind: "spawn",
          callId: "c1",
          pid: 12,
          startedAt: 2,
          command: "npm run dev",
          role: "foreground",
        },
        { kind: "exit", pid: 12 },
        { kind: "reap", pid: 11, fate: "ended" },
      ],
      disk({}),
    );
    expect(plan?.processes.map((p) => [p.pid, p.fate])).toEqual([
      [11, "ended"],
    ]);
    const text = plan?.calls[0]?.result.modelText ?? "";
    expect(text).toContain("Do not simply re-run a command with side effects");
    expect(text).toContain(
      "Process 11 (npm run dev) was still running at relaunch and was ended.",
    );
  });

  it("a write found applied closes ok; every other outcome closes as a failure the model is told about", async () => {
    const plan = await planSeal(
      [
        start(),
        asks(call("c1", "edit_file"), call("c2", "edit_file")),
        dispatched("c1"),
        wrote("c1", "a.ts", "B", "A"),
      ],
      disk({ [abs("a.ts")]: "A" }),
    );
    const [applied, notStarted] = plan?.calls ?? [];
    expect(applied?.result.ok).toBe(true);
    expect(applied?.result.modelText).toContain(
      "a.ts holds the written content. Do not repeat the change.",
    );
    expect(notStarted?.result).toMatchObject({
      ok: false,
      error: { code: "app_exit_not_started", retryable: false },
    });
  });

  it("the closers speak the run's contract language", async () => {
    const plan = await planSeal(
      [
        start({ frame: { ...start().frame, lang: "zh" } }),
        asks(call("c1", "run_command", { command: "npm test" })),
        dispatched("c1"),
      ],
      disk({}),
    );
    expect(plan?.calls[0]?.result.modelText).toContain(
      "应用退出时这条命令正在运行",
    );
  });

  it("an unchecked process says so", () => {
    expect(
      processLine(
        {
          callId: "c",
          pid: 7,
          startedAt: 0,
          command: "vite",
          role: "background",
        },
        "en",
      ),
    ).toBe(
      "Process 7 (vite) was running when the app exited and has not been checked.",
    );
  });
});
