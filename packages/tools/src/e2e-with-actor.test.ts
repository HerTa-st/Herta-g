import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type AgentEvent,
  BackendContextBuilder,
  BackgroundHost,
  CodingAgentRuntime,
  FindingsLedger,
  type HertaToAgentBrief,
  type HertaTool,
  InMemoryEventBus,
  InMemoryToolRegistry,
  NoopMemoryManager,
  type PermissionEngine,
  ReadLedger,
  RulePermissionEngine,
  TodoStore,
} from "@herta/core";
import { FakeAskResolver, FakeProvider } from "@herta/core/testing";
import { afterEach, describe, expect, it } from "vitest";
import {
  createMinimalTools,
  createMvpTools,
  editFileTool,
  readFileTool,
  registerEditFileRule,
  registerRunCommandRule,
  registerWriteNewFileRule,
  reportFindingTool,
  runCommandTool,
  todoWriteTool,
  writeNewFileTool,
} from "./index.js";
import { mkTmpWorkspace, type TmpWorkspace } from "./testing/tmp-workspace.js";

/**
 * MVP tools end-to-end. Drives `CodingAgentRuntime.runBrief` directly with
 * a synthesized brief. The earlier version of this file ran turns through
 * the deterministic V1 actor wrapper; with V1 deleted, the actor added no
 * signal here — the assertions are about the tool/turn-loop integration,
 * not actor framing — so we drive the backend runtime directly.
 */

interface RuntimeHarness {
  runtime: CodingAgentRuntime;
  bus: InMemoryEventBus<AgentEvent>;
  tools: InMemoryToolRegistry;
  permissions: PermissionEngine;
  ask: FakeAskResolver;
  workspaceRoot: string;
}

function mkRuntime(opts: {
  provider: FakeProvider;
  permissions?: PermissionEngine;
  tools?: InMemoryToolRegistry;
  ask?: FakeAskResolver;
  workspaceRoot?: string;
}): RuntimeHarness {
  const ask = opts.ask ?? new FakeAskResolver();
  const permissions = opts.permissions ?? new RulePermissionEngine({ ask });
  const tools = opts.tools ?? new InMemoryToolRegistry();
  const bus = new InMemoryEventBus<AgentEvent>();
  const backendBuilder = new BackendContextBuilder({ tools });
  const workspaceRoot = opts.workspaceRoot ?? "/repo";
  const runtime = new CodingAgentRuntime({
    sessionId: "test",
    provider: opts.provider,
    tools,
    permissions,
    backendBuilder,
    bus,
    clock: () => new Date("2026-05-08T00:00:00.000Z"),
    workspaceRoot,
    memory: new NoopMemoryManager(),
  });
  return { runtime, bus, tools, permissions, ask, workspaceRoot };
}

function brief(_text: string, taskId = "tools-e2e-1"): HertaToAgentBrief {
  return { taskId };
}

function userMessages(text: string): ReadonlyArray<{ text: string }> {
  return [{ text }];
}

let ws: TmpWorkspace;
afterEach(async () => {
  if (ws) await ws.cleanup();
});

describe("MVP tools end-to-end with CodingAgentRuntime", () => {
  it("model can call read_file and the result flows through the turn loop", async () => {
    ws = await mkTmpWorkspace({
      "src/hello.ts": "export const hello = 'world';\n",
    });

    const provider = new FakeProvider({
      turns: [
        [
          { type: "text-delta", text: "let me read the file" },
          {
            type: "tool-call-request",
            call: {
              id: "tc1",
              tool: "read_file",
              input: { path: "src/hello.ts" },
            },
          },
          { type: "finish", reason: "tool_calls" },
        ],
        [
          { type: "text-delta", text: "got it" },
          { type: "finish", reason: "stop" },
        ],
      ],
    });

    const tools = new InMemoryToolRegistry();
    for (const t of createMvpTools()) tools.register(t);
    const { runtime, bus } = mkRuntime({
      provider,
      tools,
      workspaceRoot: ws.root,
    });

    const events: AgentEvent[] = [];
    bus.onAny((e) => events.push(e));
    await runtime.runBrief(brief("what's in hello.ts?"), {
      userMessages: userMessages("what's in hello.ts?"),
    });

    const types = events.map((e) => e.type);
    expect(types).toEqual([
      "turn.started",
      "assistant.delta",
      "assistant.final",
      "tool.call.started",
      "tool.call.finished",
      "assistant.delta",
      "assistant.final",
      "turn.finished",
    ]);

    const finished = events.find((e) => e.type === "tool.call.finished");
    expect(finished).toBeDefined();
    if (finished?.type === "tool.call.finished") {
      expect(finished.id).toBe("tc1");
      expect(finished.result.ok).toBe(true);
      const data = finished.result.data as { content: string };
      expect(data.content).toContain("hello");
    }
  });

  it("marks exactly the pure-read tools readOnly (parallel-batch safety, ADR 0025 slice 5)", () => {
    const flags = new Map(
      createMvpTools().map((t) => [t.name, t.readOnly === true]),
    );
    const readOnly = [...flags.entries()]
      .filter(([, v]) => v)
      .map(([k]) => k)
      .sort();
    expect(readOnly).toEqual([
      "command_output",
      // digest_document reads an attachment and writes only its own sidecar
      // under .herta (ADR 0043) — nothing another read could observe change.
      "digest_document",
      "git_diff",
      "git_status",
      "glob",
      "read_file",
      "search_text",
      // show_excerpt reads and presents; it mutates nothing (ADR 0027).
      "show_excerpt",
    ]);
    // Mutators must never opt in — the flag is the batch-safety contract.
    for (const mutator of [
      "edit_file",
      "write_new_file",
      "run_command",
      "command_stop",
      "todo_write",
      "memory_save",
      // Appends to the per-brief findings ledger (ADR 0039) — harness state,
      // same class as todo_write; serial keeps finding indices in order.
      "report_finding",
    ]) {
      expect(flags.get(mutator), mutator).toBe(false);
    }
  });

  it("registers all fifteen MVP tools via createMvpTools (list_files left on 2026-09-18, ADR 0067)", () => {
    const tools = createMvpTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "command_output",
      "command_stop",
      "digest_document",
      "edit_file",
      "git_diff",
      "git_status",
      "glob",
      "memory_save",
      "read_file",
      "report_finding",
      "run_command",
      "search_text",
      "show_excerpt",
      "todo_write",
      "write_new_file",
    ]);
  });

  it("view_image mounts ONLY on a vision-capable model (ADR 0048 §5)", () => {
    // A model without vision answers 400 to an image part, and a tool the
    // model is told it has but cannot use is worse than no tool: it invites a
    // call that fails, and invites the model to believe it looked.
    expect(createMvpTools().map((t) => t.name)).not.toContain("view_image");
    expect(
      createMvpTools({ digestModel: null, vision: true }).map((t) => t.name),
    ).toContain("view_image");

    const minimal = (vision: boolean) =>
      createMinimalTools({
        bashPath: "/nonexistent/bash",
        workspaceShellPath: () => "/ws",
        digestModel: null,
        vision,
      }).map((t) => t.name);
    expect(minimal(false)).not.toContain("view_image");
    expect(minimal(true)).toContain("view_image");
  });

  it("createMinimalTools (ADR 0040): the trained pair plus the record channels (digest ADR 0043, todo_write ADR 0047 §4), and the record channels accept the shell's path spelling", async () => {
    ws = await mkTmpWorkspace({ "src/a.ts": "one\ntwo\nthree\n" });
    const tools = createMinimalTools({
      bashPath: "/nonexistent/bash",
      workspaceShellPath: () => ws.root,
      digestModel: null,
    });
    expect(tools.map((t) => t.name).sort()).toEqual([
      "bash",
      "digest_document",
      "report_finding",
      "show_excerpt",
      "str_replace_editor",
      // ADR 0047 §4 (owner, 2026-08-26): without it the 待办 lane was
      // structurally empty on the default contract and the GUI plan card
      // never lit for a minimal dispatch.
      "todo_write",
    ]);
    // Native and forward-slash spellings of the workspace pass; a relative
    // path passes; on Windows the /e/… MSYS form is understood too (live GUI
    // 2026-08-17: `/tmp/…` reached show_excerpt as `E:\tmp\…` — outside).
    const excerpt = tools.find((t) => t.name === "show_excerpt") as HertaTool;
    const ctx = {
      sessionId: "s",
      signal: new AbortController().signal,
      workspaceRoot: ws.root,
      reads: new ReadLedger(),
      todos: new TodoStore(),
      bg: new BackgroundHost(),
      bus: new InMemoryEventBus<AgentEvent>(),
      memory: new NoopMemoryManager(),
      findings: new FindingsLedger(),
    };
    const spellings = [
      "src/a.ts",
      join(ws.root, "src", "a.ts"),
      `${ws.root.replace(/\\/g, "/")}/src/a.ts`,
    ];
    if (process.platform === "win32") {
      spellings.push(
        `${ws.root.replace(/\\/g, "/").replace(/^([A-Za-z]):/, (_, d: string) => `/${d.toLowerCase()}`)}/src/a.ts`,
      );
    }
    for (const p of spellings) {
      const r = await excerpt.run(
        {
          id: "e",
          tool: "show_excerpt",
          input: { path: p, fromLine: 1, toLine: 2 },
        },
        ctx,
        () => {},
      );
      expect(r.ok, p).toBe(true);
    }
    const finding = tools.find((t) => t.name === "report_finding") as HertaTool;
    const r = await finding.run(
      {
        id: "f",
        tool: "report_finding",
        input: {
          claim: "a.ts has three lines",
          cites: [`${spellings[spellings.length - 1]}:1-3`],
        },
      },
      ctx,
      () => {},
    );
    expect(r.ok).toBe(true);
    // …and the recorded cite is workspace-relative regardless of spelling.
    expect((r.data as { cites: string[] }).cites).toEqual(["src/a.ts:1-3"]);
  });

  it("e2e: read_file then edit_file with ask-allow flow", async () => {
    ws = await mkTmpWorkspace({ "x.txt": "alpha\nbeta\n" });
    const abs = join(ws.root, "x.txt");
    const ask = new FakeAskResolver();
    const permissions = new RulePermissionEngine({ ask });
    const tools = new InMemoryToolRegistry();
    tools.register(readFileTool());
    tools.register(editFileTool());
    const provider = new FakeProvider({
      turns: [
        [
          {
            type: "tool-call-request",
            call: { id: "r1", tool: "read_file", input: { path: "x.txt" } },
          },
          {
            type: "tool-call-request",
            call: {
              id: "p1",
              tool: "edit_file",
              input: {
                path: "x.txt",
                hunks: [{ search: "alpha", replace: "ALPHA" }],
              },
            },
          },
          { type: "finish", reason: "tool_calls" },
        ],
        [
          { type: "text-delta", text: "done" },
          { type: "finish", reason: "stop" },
        ],
      ],
    });
    const { runtime, bus } = mkRuntime({
      provider,
      tools,
      permissions,
      ask,
      workspaceRoot: ws.root,
    });
    registerEditFileRule(permissions, { bus });

    const events: AgentEvent[] = [];
    bus.onAny((e) => events.push(e));
    bus.onAny((e) => {
      if (e.type === "permission.requested") ask.allow();
    });

    await runtime.runBrief(brief("patch alpha"), {
      userMessages: userMessages("patch alpha"),
    });

    const types = events.map((e) => e.type);
    const previewIdx = types.indexOf("patch.preview");
    const requestIdx = types.indexOf("permission.requested");
    const resolvedIdx = types.indexOf("permission.resolved");
    expect(previewIdx).toBeGreaterThanOrEqual(0);
    expect(previewIdx).toBeLessThan(requestIdx);
    expect(requestIdx).toBeLessThan(resolvedIdx);

    const reqEvt = events.find(
      (e) =>
        e.type === "permission.requested" &&
        e.request.call.tool === "edit_file",
    );
    expect(reqEvt).toBeDefined();
    if (reqEvt?.type !== "permission.requested") throw new Error();
    expect(reqEvt.request.diff).toContain("+ALPHA");
    expect(reqEvt.request.files).toEqual(["x.txt"]);

    const fin = events.find(
      (e) => e.type === "tool.call.finished" && e.id === "p1",
    );
    expect(fin?.type).toBe("tool.call.finished");
    if (fin?.type !== "tool.call.finished") throw new Error();
    expect(fin.result.ok).toBe(true);

    const onDisk = await readFile(abs, "utf-8");
    expect(onDisk).toBe("ALPHA\nbeta\n");
    const expectedSha = createHash("sha256")
      .update(Buffer.from(onDisk))
      .digest("hex");
    const data = fin.result.data as { newSha256: string };
    expect(data.newSha256).toBe(expectedSha);
  });

  it.skipIf(process.platform === "win32")(
    "e2e: run_command (allow-list) executes and persists log",
    async () => {
      ws = await mkTmpWorkspace({});
      const ask = new FakeAskResolver();
      const permissions = new RulePermissionEngine({ ask });
      const tools = new InMemoryToolRegistry();
      tools.register(runCommandTool());
      const provider = new FakeProvider({
        turns: [
          [
            {
              type: "tool-call-request",
              call: {
                id: "rc1",
                tool: "run_command",
                input: { argv: ["echo", "hi"] },
              },
            },
            { type: "finish", reason: "tool_calls" },
          ],
          [
            { type: "text-delta", text: "done" },
            { type: "finish", reason: "stop" },
          ],
        ],
      });
      const { runtime, bus } = mkRuntime({
        provider,
        tools,
        permissions,
        ask,
        workspaceRoot: ws.root,
      });
      registerRunCommandRule(permissions);

      const events: AgentEvent[] = [];
      bus.onAny((e) => events.push(e));

      await runtime.runBrief(brief("echo"), {
        userMessages: userMessages("echo"),
      });

      expect(
        events.find((e) => e.type === "permission.requested"),
      ).toBeUndefined();

      const fin = events.find(
        (e) => e.type === "tool.call.finished" && e.id === "rc1",
      );
      expect(fin?.type).toBe("tool.call.finished");
      if (fin?.type !== "tool.call.finished") throw new Error();
      expect(fin.result.ok).toBe(true);
      const data = fin.result.data as {
        stdout: string;
        logPath: string;
        exitCode: number | null;
      };
      expect(data.stdout).toBe("hi\n");
      expect(data.exitCode).toBe(0);
      const log = await readFile(`${ws.root}/${data.logPath}`, "utf-8");
      expect(log).toContain("=== herta run_command log ===");
    },
  );

  it("e2e: write_new_file with ask-allow flow, then edit_file works without separate read_file", async () => {
    ws = await mkTmpWorkspace({});
    const ask = new FakeAskResolver();
    const permissions = new RulePermissionEngine({ ask });
    const tools = new InMemoryToolRegistry();
    tools.register(writeNewFileTool());
    tools.register(editFileTool());
    const provider = new FakeProvider({
      turns: [
        [
          {
            type: "tool-call-request",
            call: {
              id: "w1",
              tool: "write_new_file",
              input: {
                path: "src/created.ts",
                content: "export const value = 1;\n",
              },
            },
          },
          {
            type: "tool-call-request",
            call: {
              id: "p1",
              tool: "edit_file",
              input: {
                path: "src/created.ts",
                hunks: [{ search: "value = 1", replace: "value = 2" }],
              },
            },
          },
          { type: "finish", reason: "tool_calls" },
        ],
        [
          { type: "text-delta", text: "done" },
          { type: "finish", reason: "stop" },
        ],
      ],
    });
    const { runtime, bus } = mkRuntime({
      provider,
      tools,
      permissions,
      ask,
      workspaceRoot: ws.root,
    });
    registerWriteNewFileRule(permissions, { bus });
    registerEditFileRule(permissions, { bus });

    const events: AgentEvent[] = [];
    bus.onAny((e) => events.push(e));
    let permIdx = 0;
    bus.onAny((e) => {
      if (e.type === "permission.requested") {
        ask.allow(permIdx);
        permIdx += 1;
      }
    });

    await runtime.runBrief(brief("create then edit"), {
      userMessages: userMessages("create then edit"),
    });

    const writePreview = events.find(
      (e) => e.type === "patch.preview" && e.diff.includes("--- /dev/null"),
    );
    expect(writePreview).toBeDefined();

    const writeFin = events.find(
      (e) => e.type === "tool.call.finished" && e.id === "w1",
    );
    expect(writeFin?.type).toBe("tool.call.finished");
    if (writeFin?.type !== "tool.call.finished") throw new Error();
    expect(writeFin.result.ok).toBe(true);

    const patchFin = events.find(
      (e) => e.type === "tool.call.finished" && e.id === "p1",
    );
    expect(patchFin?.type).toBe("tool.call.finished");
    if (patchFin?.type !== "tool.call.finished") throw new Error();
    expect(patchFin.result.ok).toBe(true);

    const final = await readFile(`${ws.root}/src/created.ts`, "utf-8");
    expect(final).toBe("export const value = 2;\n");
  });

  it("e2e: todo_write lays out steps, updates statuses, unfinished fold into nextActions — and cap the status at partial after the end-of-run check", async () => {
    ws = await mkTmpWorkspace({});
    const tools = new InMemoryToolRegistry();
    tools.register(todoWriteTool());
    let endCheck = "";
    const provider = new FakeProvider({
      turns: [
        [
          {
            type: "tool-call-request",
            call: {
              id: "t1",
              tool: "todo_write",
              input: {
                todos: [
                  {
                    content: "locate parser cursor bug",
                    status: "in_progress",
                  },
                  { content: "patch parser.ts", status: "pending" },
                  { content: "run parser tests", status: "pending" },
                ],
              },
            },
          },
          { type: "finish", reason: "tool_calls" },
        ],
        [
          {
            type: "tool-call-request",
            call: {
              id: "t2",
              tool: "todo_write",
              input: {
                todos: [
                  { content: "locate parser cursor bug", status: "completed" },
                  { content: "patch parser.ts", status: "completed" },
                  { content: "run parser tests", status: "in_progress" },
                ],
              },
            },
          },
          { type: "finish", reason: "tool_calls" },
        ],
        [
          { type: "text-delta", text: "done" },
          { type: "finish", reason: "stop" },
        ],
        // Stopped with an item open: one more step, with the end-of-run
        // check (long-run study item 4). The model leaves it open.
        (frame) => {
          endCheck =
            "trailingState" in frame ? (frame.trailingState ?? "") : "";
          return [
            { type: "text-delta", text: "the tests are still to run" },
            { type: "finish", reason: "stop" },
          ];
        },
      ],
    });
    const { runtime, bus } = mkRuntime({
      provider,
      tools,
      workspaceRoot: ws.root,
    });

    const events: AgentEvent[] = [];
    bus.onAny((e) => events.push(e));

    const report = await runtime.runBrief(brief("fix the parser"), {
      userMessages: userMessages("fix the parser"),
    });
    expect(endCheck).toContain("收尾检查");
    // An open item caps the status as a refusal does (owner 2026-09-29):
    // 完成 beside ↳ 待办 would claim work the list says is not done.
    expect(report.status).toBe("partial");

    // Both full-list writes publish plan.updated with the new todo payload.
    const planEvents = events.filter((e) => e.type === "plan.updated");
    expect(planEvents).toHaveLength(2);
    const last = planEvents[1];
    expect(last?.type).toBe("plan.updated");
    if (last?.type === "plan.updated") {
      expect(last.todos).toHaveLength(3);
      expect(last.todos.filter((t) => t.status === "completed")).toHaveLength(
        2,
      );
    }

    // The item still in_progress at brief end folds into nextActions
    // (ADR 0025 §2) — the honest unfinished list, not a claim of done.
    expect(report.nextActions).toEqual(["run parser tests"]);
  });

  it("e2e: a run that brings its list up to date after the end-of-run check reports completed", async () => {
    ws = await mkTmpWorkspace({
      "src/parser.ts": "export const cursor = 0;\n",
    });
    const tools = new InMemoryToolRegistry();
    tools.register(todoWriteTool());
    tools.register(reportFindingTool());
    const write = (id: string, status: "pending" | "completed") => [
      {
        type: "tool-call-request" as const,
        call: {
          id,
          tool: "todo_write",
          input: { todos: [{ content: "find the cursor bug", status }] },
        },
      },
      { type: "finish" as const, reason: "tool_calls" as const },
    ];
    const provider = new FakeProvider({
      turns: [
        write("t1", "pending"),
        [
          {
            type: "tool-call-request",
            call: {
              id: "f1",
              tool: "report_finding",
              input: {
                claim: "the cursor starts at 0 and is never reset",
                cites: ["src/parser.ts:1"],
              },
            },
          },
          { type: "finish", reason: "tool_calls" },
        ],
        // Did the work, forgot to mark it: the check catches exactly this.
        [
          { type: "text-delta", text: "done" },
          { type: "finish", reason: "stop" },
        ],
        write("t2", "completed"),
        [
          { type: "text-delta", text: "done" },
          { type: "finish", reason: "stop" },
        ],
      ],
    });
    const { runtime } = mkRuntime({ provider, tools, workspaceRoot: ws.root });

    const report = await runtime.runBrief(brief("fix the parser"), {
      userMessages: userMessages("fix the parser"),
    });
    expect(report.status).toBe("completed");
    expect(report.nextActions).toEqual([]);
  });

  it("e2e: a background command left running is reaped when the brief ends (ADR 0025 slice 4)", async () => {
    ws = await mkTmpWorkspace({});
    const tools = new InMemoryToolRegistry();
    for (const t of createMvpTools()) tools.register(t);
    const provider = new FakeProvider({
      turns: [
        [
          {
            type: "tool-call-request",
            call: {
              id: "bg1",
              tool: "run_command",
              input: {
                argv: [process.execPath, "-e", "setInterval(()=>{}, 1000);"],
                runInBackground: true,
              },
            },
          },
          { type: "finish", reason: "tool_calls" },
        ],
        // The model "forgets" to stop it — the runtime must reap it anyway.
        [
          { type: "text-delta", text: "started the server" },
          { type: "finish", reason: "stop" },
        ],
      ],
    });
    const { runtime, bus } = mkRuntime({
      provider,
      tools,
      workspaceRoot: ws.root,
    });
    const events: AgentEvent[] = [];
    bus.onAny((e) => events.push(e));

    const report = await runtime.runBrief(brief("start the dev server"), {
      userMessages: userMessages("start the dev server"),
    });

    // The start succeeded and returned a backgroundId…
    const started = events.find(
      (e) => e.type === "tool.call.finished" && e.id === "bg1",
    );
    expect(started?.type).toBe("tool.call.finished");
    if (started?.type === "tool.call.finished") {
      expect(started.result.ok).toBe(true);
      expect(
        (started.result.data as { backgroundId?: string }).backgroundId,
      ).toBeDefined();
    }
    // …and the leftover process is noted as stopped in residualRisks (the
    // runtime's finally-block reaping — no unmanaged backgrounding).
    expect(
      report.residualRisks.some((r) => /background command.*stopped/.test(r)),
    ).toBe(true);
  });
});
