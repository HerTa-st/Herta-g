import { isAbsolute, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  REAL_TURN_COMMAND,
  REAL_TURN_EVENTS,
} from "./__fixtures__/real-turn.js";
import type { DshSessionEvent } from "./events.js";
import {
  changedFilesFromReceipts,
  collectToolReceipts,
  declaredToolNames,
  parseToolCallCommand,
  projectRun,
  statusFromTurnReason,
  turnReasonOf,
} from "./project-report.js";

const TASK_ID = "task-1";

function completedTurn(): readonly DshSessionEvent[] {
  return REAL_TURN_EVENTS;
}

describe("projectRun against a real captured turn", () => {
  it("reports the turn the harness actually ran", () => {
    const report = projectRun({ taskId: TASK_ID, events: completedTurn() });

    expect(report.taskId).toBe(TASK_ID);
    expect(report.status).toBe("completed");
    expect(report.evidence).toHaveLength(1);
    expect(report.permissions).toEqual([]);
    expect(report.residualRisks).toEqual([
      "DSH 仅暴露 pwsh：文件改动由 shell 文本推断，非结构化写结果",
    ]);
    expect(report.nextActions).toEqual([]);
  });

  it("carries the receipt as command evidence, not as prose", () => {
    const report = projectRun({ taskId: TASK_ID, events: completedTurn() });
    const [evidence] = report.evidence;

    expect(evidence?.kind).toBe("command");
    expect(evidence?.summary).toContain(REAL_TURN_COMMAND.slice(0, 40));
    expect(evidence?.summary.startsWith("$ ")).toBe(true);
    // The callId, so a reader can match the receipt back to the wire.
    expect(evidence?.source).toBe("call_00_NlFCUbWhBLIhrAowlii46079");
  });

  it("never carries the model's own final prose", () => {
    // `finalResponse` is dropped by design: Herta narrates, the harness must
    // not get a second voice through the report.
    const report = projectRun({ taskId: TASK_ID, events: completedTurn() });
    const serialized = JSON.stringify(report);

    expect(serialized).not.toContain("fixture.txt contains");
    expect(serialized).not.toContain("finalResponse");
    expect(Object.keys(report)).not.toContain("summary");
  });

  it("recovers the written file from the shell command", () => {
    const report = projectRun({ taskId: TASK_ID, events: completedTurn() });

    expect(report.changedFiles).toEqual([
      {
        path: "fixture.txt",
        kind: "modified",
        diffSummary: "written via pwsh",
      },
    ]);
  });

  it("reports no tests when the turn ran none", () => {
    const report = projectRun({ taskId: TASK_ID, events: completedTurn() });
    expect(report.tests).toEqual([]);
  });
});

describe("statusFromTurnReason", () => {
  it("maps the observed reasons", () => {
    expect(statusFromTurnReason({ kind: "completed" })).toBe("completed");
    expect(statusFromTurnReason(undefined)).toBe("partial");
    expect(statusFromTurnReason({ kind: "error" })).toBe("failed");
    expect(statusFromTurnReason({ kind: "max-tokens" })).toBe("failed");
  });

  it("never invents an interrupted outcome", () => {
    // The wire has no cancel, so no backend reason can mean "the user stopped
    // it" — that status belongs to the local wait, not to the harness.
    for (const kind of [
      "completed",
      "error",
      "max-tokens",
      "aborted",
      "cancelled",
    ]) {
      expect(statusFromTurnReason({ kind })).not.toBe("interrupted");
    }
  });
});

describe("turnReasonOf", () => {
  it("reads the structured reason off turn/end", () => {
    const events: readonly DshSessionEvent[] = [
      { type: "turn/end", data: { reason: { kind: "completed" } } },
    ];
    expect(turnReasonOf(events[0])).toEqual({ kind: "completed" });
  });

  it("ignores the bare-string reason other events carry under the same key", () => {
    const events: readonly DshSessionEvent[] = [
      { type: "step/end", data: { reason: "initial" } },
      { type: "turn/end", data: { reason: "initial" } },
    ];
    expect(turnReasonOf(events[0])).toBeUndefined();
    expect(turnReasonOf(events[1])).toBeUndefined();
    expect(turnReasonOf(undefined)).toBeUndefined();
  });
});

describe("collectToolReceipts", () => {
  it("pairs the real call with its result", () => {
    const { receipts, unmatchedCalls } = collectToolReceipts(REAL_TURN_EVENTS);

    expect(unmatchedCalls).toEqual([]);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]?.name).toBe("pwsh");
    expect(receipts[0]?.command).toBe(REAL_TURN_COMMAND);
    expect(receipts[0]?.isError).toBe(false);
    expect(receipts[0]?.text).toContain("ok");
  });

  it("drops an orphaned call rather than claiming it ran", () => {
    const events: readonly DshSessionEvent[] = [
      {
        type: "tool/call",
        data: {
          callId: "c1",
          name: "pwsh",
          arguments: '{"command":"echo hi"}',
        },
      },
    ];
    const { receipts, unmatchedCalls } = collectToolReceipts(events);

    expect(receipts).toEqual([]);
    expect(unmatchedCalls).toEqual(["pwsh"]);
  });

  it("records a tool error as an error receipt", () => {
    const events: readonly DshSessionEvent[] = [
      {
        type: "tool/call",
        data: { callId: "c1", name: "pwsh", arguments: '{"command":"boom"}' },
      },
      {
        type: "tool/result",
        data: {
          message: {
            source: { kind: "tool", callId: "c1" },
            content: [
              {
                type: "tool-result",
                toolCallId: "c1",
                isError: true,
                content: [{ type: "text", text: "nope" }],
              },
            ],
          },
        },
      },
    ];
    const { receipts } = collectToolReceipts(events);

    expect(receipts).toHaveLength(1);
    expect(receipts[0]?.isError).toBe(true);
    expect(receipts[0]?.text).toBe("nope");
  });
});

describe("parseToolCallCommand", () => {
  it("parses the JSON string the wire carries", () => {
    expect(parseToolCallCommand('{"command":"echo hi"}')).toBe("echo hi");
  });

  it("degrades instead of throwing on anything else", () => {
    for (const raw of [
      undefined,
      "",
      "not json",
      "null",
      "42",
      '"str"',
      '{"other":1}',
      '{"command":9}',
    ]) {
      expect(parseToolCallCommand(raw)).toBeUndefined();
    }
  });
});

describe("changedFilesFromReceipts", () => {
  const write = (command: string, isError = false) => ({
    name: "pwsh",
    command,
    isError,
    text: "",
  });

  it("recognises each write verb, in both spellings of -Path", () => {
    const receipts = [
      write("Set-Content -Path a.txt -Value 1"),
      write("Add-Content b.txt 'x'"),
      write("Out-File -FilePath c.txt"),
      write("Set-Content -LiteralPath d.txt 1"),
    ];
    expect(changedFilesFromReceipts(receipts).map((file) => file.path)).toEqual(
      ["a.txt", "b.txt", "c.txt", "d.txt"],
    );
  });

  it("refuses to guess when a value-taking switch precedes the path", () => {
    // `New-Item -ItemType File x.txt` must yield nothing at all rather than
    // reporting a file named "File" — a wrong 变更文件 becomes a false claim
    // in Herta's narration.
    expect(
      changedFilesFromReceipts([write("New-Item -ItemType File x.txt")]),
    ).toEqual([]);
    expect(
      changedFilesFromReceipts([write("New-Item -ItemType Directory -Path d")]),
    ).toEqual([
      { path: "d", kind: "modified", diffSummary: "written via pwsh" },
    ]);
  });

  it("keeps quoted paths with spaces whole", () => {
    const receipts = [
      write("Set-Content -Path 'my notes.txt' 1"),
      write('Out-File "a b.txt"'),
    ];
    expect(changedFilesFromReceipts(receipts).map((file) => file.path)).toEqual(
      ["my notes.txt", "a b.txt"],
    );
  });

  it("stops at the end of the statement", () => {
    const receipts = [write("Set-Content a.txt 1; Get-Content b.txt")];
    expect(changedFilesFromReceipts(receipts).map((file) => file.path)).toEqual(
      ["a.txt"],
    );
  });

  it("collapses a leading . so one file is not reported twice", () => {
    // Models habitually write `.\x` / `./x`; Herta reads these as
    // workspace-relative, so a surviving prefix would read as a second file.
    const receipts = [
      write('Set-Content -Path ".\\e2e.txt" -Value 1'),
      write("Set-Content e2e.txt 2"),
      write("Out-File ./nested/e2e.txt"),
    ];
    const files = changedFilesFromReceipts(receipts);
    expect(files.map((file) => file.path)).toEqual([
      "e2e.txt",
      "nested/e2e.txt",
    ]);
    expect(files).toHaveLength(2);
  });

  it("leaves a real parent reference intact", () => {
    // `../` is not a prefix to strip — it names a different file.
    const receipts = [write("Set-Content ../outside.txt 1")];
    expect(changedFilesFromReceipts(receipts).map((file) => file.path)).toEqual(
      ["../outside.txt"],
    );
  });

  it("handles quoted and unquoted paths identically", () => {
    const receipts = [
      write("Set-Content 'a.txt' 1"),
      write('Set-Content "b.txt" 1'),
      write("Set-Content c.txt 1"),
    ];
    expect(changedFilesFromReceipts(receipts).map((file) => file.path)).toEqual(
      ["a.txt", "b.txt", "c.txt"],
    );
  });

  it("de-duplicates a path written twice", () => {
    const receipts = [
      write("Set-Content a.txt 1"),
      write("Add-Content a.txt 2"),
    ];
    expect(changedFilesFromReceipts(receipts)).toHaveLength(1);
  });

  it("ignores reads and failed writes", () => {
    expect(changedFilesFromReceipts([write("Get-Content a.txt")])).toEqual([]);
    expect(
      changedFilesFromReceipts([write("Set-Content a.txt 1", true)]),
    ).toEqual([]);
  });

  it("normalises separators so the same file is one entry", () => {
    const receipts = [
      write("Set-Content sub\\a.txt 1"),
      write("Set-Content sub/a.txt 1"),
    ];
    expect(changedFilesFromReceipts(receipts).map((file) => file.path)).toEqual(
      ["sub/a.txt"],
    );
  });
});

describe("changedFilesFromReceipts — workspace relativisation", () => {
  const write = (command: string) => ({
    name: "pwsh",
    command,
    isError: false,
    text: "",
  });
  const workspace = resolve("ws");

  it("reports an absolute in-workspace write the way Herta reports it", () => {
    // Observed for real: the model wrote an absolute path, and the raw
    // projection leaked the machine's directory layout into a field Herta
    // compares against git's repo-relative paths and narrates to the user.
    const receipts = [
      write(`Set-Content -Path '${join(workspace, "hello.txt")}' -Value x`),
    ];
    expect(changedFilesFromReceipts(receipts, workspace)).toEqual([
      { path: "hello.txt", kind: "modified", diffSummary: "written via pwsh" },
    ]);
  });

  it("reports a nested absolute write as a relative forward-slash path", () => {
    const receipts = [
      write(`Out-File -FilePath "${join(workspace, "sub", "deep", "a.txt")}"`),
    ];
    expect(changedFilesFromReceipts(receipts, workspace)[0]?.path).toBe(
      "sub/deep/a.txt",
    );
  });

  it("folds an absolute spelling and a relative spelling of one file together", () => {
    const receipts = [
      write(`Set-Content -Path '${join(workspace, "a.txt")}' 1`),
      write("Add-Content a.txt 2"),
    ];
    expect(changedFilesFromReceipts(receipts, workspace)).toHaveLength(1);
  });

  it("collapses an absolute path that walks up and back down", () => {
    const receipts = [
      write(`Set-Content '${join(workspace, "sub", "..", "a.txt")}' 1`),
    ];
    expect(changedFilesFromReceipts(receipts, workspace)[0]?.path).toBe(
      "a.txt",
    );
  });

  it("leaves a write outside the workspace absolute", () => {
    // A write outside the workspace is worth seeing in full — rewriting it as
    // `../../..` would hide where the file actually landed.
    const outside = join(resolve("elsewhere"), "note.txt");
    const receipts = [write(`Set-Content -Path '${outside}' 1`)];
    expect(
      isAbsolute(changedFilesFromReceipts(receipts, workspace)[0]?.path ?? ""),
    ).toBe(true);
  });

  it("leaves an escaping relative write untouched", () => {
    const receipts = [write("Set-Content ../outside.txt 1")];
    expect(changedFilesFromReceipts(receipts, workspace)[0]?.path).toBe(
      "../outside.txt",
    );
  });

  it("passes the path through when no workspace is known", () => {
    const absolute = join(workspace, "a.txt");
    const receipts = [write(`Set-Content -Path '${absolute}' 1`)];
    expect(changedFilesFromReceipts(receipts)[0]?.path).toBe(
      absolute.replace(/\\/gu, "/"),
    );
  });

  it("relativises through projectRun, not only the helper", () => {
    const file = join(workspace, "cli-mount-ok.txt");
    const events: readonly DshSessionEvent[] = [
      {
        type: "tool/call",
        data: {
          callId: "c1",
          name: "pwsh",
          arguments: JSON.stringify({
            command: `Set-Content -Path '${file}' -Value ok`,
          }),
        },
      },
      {
        type: "tool/result",
        data: {
          message: {
            source: { kind: "tool", callId: "c1" },
            content: [
              {
                type: "tool-result",
                toolCallId: "c1",
                content: [{ type: "text", text: "" }],
              },
            ],
          },
        },
      },
    ];
    const report = projectRun({ taskId: TASK_ID, events, workspace });
    expect(report.changedFiles.map((changed) => changed.path)).toEqual([
      "cli-mount-ok.txt",
    ]);
  });
});

describe("declaredToolNames", () => {
  it("reads the harness tool inventory off request/header", () => {
    expect(declaredToolNames(REAL_TURN_EVENTS)).toEqual(["pwsh"]);
  });

  it("returns nothing when the header never arrived", () => {
    expect(declaredToolNames([])).toEqual([]);
  });
});

describe("projectRun failure paths", () => {
  const writeCall = (callId: string): readonly DshSessionEvent[] => [
    {
      type: "tool/call",
      data: {
        turn: 1,
        step: 1,
        callId,
        name: "pwsh",
        arguments: '{"command":"x"}',
      },
    },
  ];

  it("marks a transport error failed and keeps the error text as a risk", () => {
    const report = projectRun({
      taskId: TASK_ID,
      events: writeCall("c1"),
      transportError: "Cannot read properties of undefined (reading 'prepare')",
    });

    expect(report.status).toBe("failed");
    expect(report.residualRisks).toContain(
      "DSH 传输错误：Cannot read properties of undefined (reading 'prepare')",
    );
    expect(
      report.residualRisks.some((risk) => risk.includes("未收到结果")),
    ).toBe(true);
    // A transport failure says nothing about whether the turn ended, so the
    // missing-`turn/end` advice must not be offered here.
    expect(report.nextActions).toEqual([
      "重试该 板砖 派发，或检查模型凭证与网络",
    ]);
  });

  it("surfaces a turn/end error reason", () => {
    const events: readonly DshSessionEvent[] = [
      ...writeCall("c1"),
      {
        type: "turn/end",
        data: {
          turn: 1,
          reason: {
            kind: "error",
            error: { message: "boom", code: "MISSING_CREDENTIAL" },
          },
        },
      },
    ];
    const report = projectRun({ taskId: TASK_ID, events });

    expect(report.status).toBe("failed");
    expect(report.residualRisks).toContain("后端回合报错：boom");
  });

  it("flags a turn that never ended as untrustworthy", () => {
    const report = projectRun({ taskId: TASK_ID, events: writeCall("c1") });

    expect(report.status).toBe("partial");
    expect(report.residualRisks).toContain(
      "未观察到 turn/end 事件，本回合结论不可信",
    );
    expect(report.nextActions).toContain("确认 DSH 子进程是否仍存活");
  });

  it("treats an empty event list as an untrustworthy partial, not an error", () => {
    const report = projectRun({ taskId: TASK_ID, events: [] });

    expect(report.status).toBe("partial");
    // No events means nothing to contradict: only a transport error would
    // justify calling this failed.
    expect(report.residualRisks).toEqual([]);
    expect(report.evidence).toEqual([]);
  });
});

describe("projectRun tests[]", () => {
  function turnWith(command: string): readonly DshSessionEvent[] {
    return [
      {
        type: "tool/call",
        data: {
          callId: "c1",
          name: "pwsh",
          arguments: JSON.stringify({ command }),
        },
      },
      {
        type: "tool/result",
        data: {
          message: {
            source: { kind: "tool", callId: "c1" },
            content: [
              {
                type: "tool-result",
                toolCallId: "c1",
                content: [{ type: "text", text: "12 passed" }],
              },
            ],
          },
        },
      },
      { type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } },
    ];
  }

  it("recognises the runners worth reporting", () => {
    const runners = [
      "pnpm test",
      "pnpm run test",
      "npm test",
      "yarn test",
      "bun test",
      "pytest -q",
      "cargo test",
      "go test ./...",
      "npx vitest run",
    ];
    for (const command of runners) {
      expect(
        projectRun({ taskId: TASK_ID, events: turnWith(command) }).tests,
      ).toHaveLength(1);
    }
  });

  it("reports the command, outcome, and output", () => {
    const report = projectRun({
      taskId: TASK_ID,
      events: turnWith("pnpm test"),
    });
    expect(report.tests).toEqual([
      { command: "pnpm test", status: "passed", summary: "12 passed" },
    ]);
  });

  it("marks a failed runner as failed", () => {
    const events: readonly DshSessionEvent[] = [
      {
        type: "tool/call",
        data: {
          callId: "c1",
          name: "pwsh",
          arguments: '{"command":"pnpm test"}',
        },
      },
      {
        type: "tool/result",
        data: {
          message: {
            source: { kind: "tool", callId: "c1" },
            content: [
              {
                type: "tool-result",
                toolCallId: "c1",
                isError: true,
                content: [{ type: "text", text: "1 failed" }],
              },
            ],
          },
        },
      },
    ];
    expect(projectRun({ taskId: TASK_ID, events }).tests[0]?.status).toBe(
      "failed",
    );
  });

  it("does not report an ordinary command as a test run", () => {
    const report = projectRun({
      taskId: TASK_ID,
      events: turnWith("Get-Content a.txt"),
    });
    expect(report.tests).toEqual([]);
  });
});
