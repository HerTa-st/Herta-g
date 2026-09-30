import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  type AgentEvent,
  BackgroundHost,
  InMemoryEventBus,
  NoopMemoryManager,
  ReadLedger,
  RulePermissionEngine,
} from "@herta/core";
import { FakeAskResolver } from "@herta/core/testing";
import { afterEach, describe, expect, it } from "vitest";
import { mkTmpWorkspace, type TmpWorkspace } from "../testing/tmp-workspace.js";
import { registerWriteNewFileRule } from "./rule.js";

let ws: TmpWorkspace;
afterEach(async () => {
  if (ws) await ws.cleanup();
});

function ctxFor(workspaceRoot: string) {
  return {
    sessionId: "s",
    signal: new AbortController().signal,
    workspaceRoot,
    reads: new ReadLedger(),
    bg: new BackgroundHost(),
    bus: new InMemoryEventBus<AgentEvent>(),
    memory: new NoopMemoryManager(),
  };
}

describe("write_new_file permission rule", () => {
  it("happy path: returns ask with /dev/null diff and emits one patch.preview", async () => {
    ws = await mkTmpWorkspace({});
    const bus = new InMemoryEventBus<AgentEvent>();
    const previews: AgentEvent[] = [];
    bus.onAny((e) => {
      if (e.type === "patch.preview") previews.push(e);
    });
    const engine = new RulePermissionEngine({ ask: new FakeAskResolver() });
    registerWriteNewFileRule(engine, { bus });
    const decision = await engine.check(
      {
        id: "1",
        tool: "write_new_file",
        input: { path: "src/new.ts", content: "export const x = 1;\n" },
      },
      ctxFor(ws.root),
    );
    expect(decision.kind).toBe("ask");
    if (decision.kind !== "ask") throw new Error();
    expect(decision.request.diff).toContain("--- /dev/null");
    expect(decision.request.diff).toContain("+++ b/src/new.ts");
    expect(decision.request.diff).toContain("+export const x = 1;");
    expect(decision.request.files).toEqual(["src/new.ts"]);
    expect(decision.request.risk).toBe("workspace_write");
    expect(previews).toHaveLength(1);
  });

  it("denies file_exists when path already exists as a file", async () => {
    ws = await mkTmpWorkspace({ "a.txt": "existing" });
    const engine = new RulePermissionEngine({ ask: new FakeAskResolver() });
    registerWriteNewFileRule(engine);
    const decision = await engine.check(
      {
        id: "1",
        tool: "write_new_file",
        input: { path: "a.txt", content: "new" },
      },
      ctxFor(ws.root),
    );
    expect(decision.kind).toBe("deny");
    if (decision.kind !== "deny") throw new Error();
    expect(decision.code).toBe("file_exists");
  });

  it("denies file_exists when path is an existing directory", async () => {
    ws = await mkTmpWorkspace({});
    await mkdir(join(ws.root, "subdir"));
    const engine = new RulePermissionEngine({ ask: new FakeAskResolver() });
    registerWriteNewFileRule(engine);
    const decision = await engine.check(
      {
        id: "1",
        tool: "write_new_file",
        input: { path: "subdir", content: "x" },
      },
      ctxFor(ws.root),
    );
    expect(decision.kind).toBe("deny");
    if (decision.kind !== "deny") throw new Error();
    expect(decision.code).toBe("file_exists");
  });

  it("denies path_denied for .git paths", async () => {
    ws = await mkTmpWorkspace({});
    const engine = new RulePermissionEngine({ ask: new FakeAskResolver() });
    registerWriteNewFileRule(engine);
    const decision = await engine.check(
      {
        id: "1",
        tool: "write_new_file",
        input: { path: ".git/HEAD", content: "x" },
      },
      ctxFor(ws.root),
    );
    expect(decision.kind).toBe("deny");
    if (decision.kind !== "deny") throw new Error();
    expect(decision.code).toBe("path_denied");
  });

  it("denies parent_invalid when parent path resolves to an existing file", async () => {
    ws = await mkTmpWorkspace({ "thing.txt": "I am a file, not a dir" });
    const engine = new RulePermissionEngine({ ask: new FakeAskResolver() });
    registerWriteNewFileRule(engine);
    const decision = await engine.check(
      {
        id: "1",
        tool: "write_new_file",
        input: { path: "thing.txt/child.txt", content: "x" },
      },
      ctxFor(ws.root),
    );
    expect(decision.kind).toBe("deny");
    if (decision.kind !== "deny") throw new Error();
    // parent_invalid on every platform: POSIX stat surfaces ENOTDIR, Windows
    // surfaces ENOENT and the parent check fires — the rule normalizes both
    // (previously Linux returned read_failed, which broke CI on the runner).
    expect(decision.code).toBe("parent_invalid");
  });

  it("denies file_too_large when content exceeds 10MB", async () => {
    ws = await mkTmpWorkspace({});
    const engine = new RulePermissionEngine({ ask: new FakeAskResolver() });
    registerWriteNewFileRule(engine);
    const big = "x".repeat(10 * 1024 * 1024 + 1);
    const decision = await engine.check(
      {
        id: "1",
        tool: "write_new_file",
        input: { path: "big.txt", content: big },
      },
      ctxFor(ws.root),
    );
    expect(decision.kind).toBe("deny");
    if (decision.kind !== "deny") throw new Error();
    expect(decision.code).toBe("file_too_large");
  });

  it("denies invalid_input for missing path", async () => {
    ws = await mkTmpWorkspace({});
    const engine = new RulePermissionEngine({ ask: new FakeAskResolver() });
    registerWriteNewFileRule(engine);
    const decision = await engine.check(
      { id: "1", tool: "write_new_file", input: { content: "x" } },
      ctxFor(ws.root),
    );
    expect(decision.kind).toBe("deny");
    if (decision.kind !== "deny") throw new Error();
    expect(decision.code).toBe("invalid_input");
  });

  it("allows empty content (creates 0-byte file)", async () => {
    ws = await mkTmpWorkspace({});
    const engine = new RulePermissionEngine({ ask: new FakeAskResolver() });
    registerWriteNewFileRule(engine);
    const decision = await engine.check(
      {
        id: "1",
        tool: "write_new_file",
        input: { path: "empty.txt", content: "" },
      },
      ctxFor(ws.root),
    );
    expect(decision.kind).toBe("ask");
  });

  it("allows nested paths where intermediate dirs do not exist yet", async () => {
    ws = await mkTmpWorkspace({});
    const engine = new RulePermissionEngine({ ask: new FakeAskResolver() });
    registerWriteNewFileRule(engine);
    const decision = await engine.check(
      {
        id: "1",
        tool: "write_new_file",
        input: { path: "a/b/c/new.ts", content: "x" },
      },
      ctxFor(ws.root),
    );
    expect(decision.kind).toBe("ask");
  });
});
