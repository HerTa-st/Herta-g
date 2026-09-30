import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
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
import { registerEditFileRule } from "./rule.js";

let ws: TmpWorkspace;
afterEach(async () => {
  if (ws) await ws.cleanup();
});

function ctxFor(workspaceRoot: string, reads: ReadLedger) {
  return {
    sessionId: "s",
    signal: new AbortController().signal,
    workspaceRoot,
    reads,
    bg: new BackgroundHost(),
    bus: new InMemoryEventBus<AgentEvent>(),
    memory: new NoopMemoryManager(),
  };
}

async function recordSha(reads: ReadLedger, abs: string): Promise<string> {
  const buf = await readFile(abs);
  const sha = createHash("sha256").update(buf).digest("hex");
  reads.record(abs, sha);
  return sha;
}

describe("edit_file permission rule", () => {
  it("denies with code=read_required when no prior read in ledger", async () => {
    ws = await mkTmpWorkspace({ "a.txt": "alpha\nbeta\n" });
    const engine = new RulePermissionEngine({ ask: new FakeAskResolver() });
    registerEditFileRule(engine);
    const decision = await engine.check(
      {
        id: "1",
        tool: "edit_file",
        input: {
          path: "a.txt",
          hunks: [{ search: "alpha", replace: "ALPHA" }],
        },
      },
      ctxFor(ws.root, new ReadLedger()),
    );
    expect(decision.kind).toBe("deny");
    if (decision.kind !== "deny") throw new Error();
    expect(decision.code).toBe("read_required");
  });

  it("denies with code=stale_read when ledger sha differs", async () => {
    ws = await mkTmpWorkspace({ "a.txt": "alpha\n" });
    const reads = new ReadLedger();
    reads.record(join(ws.root, "a.txt"), "deadbeef-not-the-real-hash");
    const engine = new RulePermissionEngine({ ask: new FakeAskResolver() });
    registerEditFileRule(engine);
    const decision = await engine.check(
      {
        id: "1",
        tool: "edit_file",
        input: {
          path: "a.txt",
          hunks: [{ search: "alpha", replace: "X" }],
        },
      },
      ctxFor(ws.root, reads),
    );
    expect(decision.kind).toBe("deny");
    if (decision.kind !== "deny") throw new Error();
    expect(decision.code).toBe("stale_read");
  });

  it("denies for empty hunks via zod (invalid_input)", async () => {
    ws = await mkTmpWorkspace({ "a.txt": "alpha\n" });
    const reads = new ReadLedger();
    await recordSha(reads, join(ws.root, "a.txt"));
    const engine = new RulePermissionEngine({ ask: new FakeAskResolver() });
    registerEditFileRule(engine);
    const decision = await engine.check(
      { id: "1", tool: "edit_file", input: { path: "a.txt", hunks: [] } },
      ctxFor(ws.root, reads),
    );
    expect(decision.kind).toBe("deny");
    if (decision.kind !== "deny") throw new Error();
    expect(["parse_failed", "invalid_input"]).toContain(decision.code);
  });

  it("denies with code=hunk_not_found when search absent", async () => {
    ws = await mkTmpWorkspace({ "a.txt": "alpha\n" });
    const reads = new ReadLedger();
    await recordSha(reads, join(ws.root, "a.txt"));
    const engine = new RulePermissionEngine({ ask: new FakeAskResolver() });
    registerEditFileRule(engine);
    const decision = await engine.check(
      {
        id: "1",
        tool: "edit_file",
        input: { path: "a.txt", hunks: [{ search: "moon", replace: "x" }] },
      },
      ctxFor(ws.root, reads),
    );
    expect(decision.kind).toBe("deny");
    if (decision.kind !== "deny") throw new Error();
    expect(decision.code).toBe("hunk_not_found");
  });

  it("denies with code=hunk_ambiguous when search appears multiple times", async () => {
    ws = await mkTmpWorkspace({ "a.txt": "foo foo\n" });
    const reads = new ReadLedger();
    await recordSha(reads, join(ws.root, "a.txt"));
    const engine = new RulePermissionEngine({ ask: new FakeAskResolver() });
    registerEditFileRule(engine);
    const decision = await engine.check(
      {
        id: "1",
        tool: "edit_file",
        input: { path: "a.txt", hunks: [{ search: "foo", replace: "bar" }] },
      },
      ctxFor(ws.root, reads),
    );
    expect(decision.kind).toBe("deny");
    if (decision.kind !== "deny") throw new Error();
    expect(decision.code).toBe("hunk_ambiguous");
  });

  it("happy path: returns ask with diff + files; emits exactly one patch.preview", async () => {
    ws = await mkTmpWorkspace({ "a.txt": "alpha\nbeta\n" });
    const reads = new ReadLedger();
    await recordSha(reads, join(ws.root, "a.txt"));
    const bus = new InMemoryEventBus<AgentEvent>();
    const previews: AgentEvent[] = [];
    bus.onAny((e) => {
      if (e.type === "patch.preview") previews.push(e);
    });
    const engine = new RulePermissionEngine({ ask: new FakeAskResolver() });
    registerEditFileRule(engine, { bus });
    const decision = await engine.check(
      {
        id: "1",
        tool: "edit_file",
        input: {
          path: "a.txt",
          hunks: [{ search: "alpha", replace: "ALPHA" }],
        },
      },
      ctxFor(ws.root, reads),
    );
    expect(decision.kind).toBe("ask");
    if (decision.kind !== "ask") throw new Error();
    expect(decision.request.diff).toContain("-alpha");
    expect(decision.request.diff).toContain("+ALPHA");
    expect(decision.request.files).toEqual(["a.txt"]);
    expect(decision.request.risk).toBe("workspace_write");
    expect(previews).toHaveLength(1);
  });

  it("denies with code=path_denied for .git paths", async () => {
    ws = await mkTmpWorkspace({});
    const engine = new RulePermissionEngine({ ask: new FakeAskResolver() });
    registerEditFileRule(engine);
    const decision = await engine.check(
      {
        id: "1",
        tool: "edit_file",
        input: {
          path: ".git/HEAD",
          hunks: [{ search: "x", replace: "y" }],
        },
      },
      ctxFor(ws.root, new ReadLedger()),
    );
    expect(decision.kind).toBe("deny");
    if (decision.kind !== "deny") throw new Error();
    expect(decision.code).toBe("path_denied");
  });

  it("denies with code=not_found when target file does not exist", async () => {
    ws = await mkTmpWorkspace({});
    const engine = new RulePermissionEngine({ ask: new FakeAskResolver() });
    registerEditFileRule(engine);
    const decision = await engine.check(
      {
        id: "1",
        tool: "edit_file",
        input: {
          path: "missing.txt",
          hunks: [{ search: "x", replace: "y" }],
        },
      },
      ctxFor(ws.root, new ReadLedger()),
    );
    expect(decision.kind).toBe("deny");
    if (decision.kind !== "deny") throw new Error();
    expect(decision.code).toBe("not_found");
  });
});
