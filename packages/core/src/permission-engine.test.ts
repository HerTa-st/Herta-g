import { describe, expect, it } from "vitest";
import { BackgroundHost } from "./backend/background-host.js";
import { InMemoryEventBus } from "./event-bus.js";
import { NoopMemoryManager } from "./memory-manager.js";
import {
  type AskResolver,
  type PermissionRule,
  type RiskLevel,
  RulePermissionEngine,
  type RuleVerdict,
} from "./permission-engine.js";
import { ReadLedger } from "./read-ledger.js";
import { FakeAskResolver } from "./testing/fake-ask-resolver.js";
import type { AgentEvent, PermissionRequest } from "./types/events.js";
import type { ToolCallRequest, ToolContext, ToolResult } from "./types/tool.js";

function makeCall(tool = "read_file"): ToolCallRequest {
  return { id: "c1", tool, input: {} };
}

function makeCtx(): ToolContext {
  return {
    sessionId: "s1",
    signal: new AbortController().signal,
    workspaceRoot: "/tmp/ws",
    reads: new ReadLedger(),
    bg: new BackgroundHost(),
    bus: new InMemoryEventBus<AgentEvent>(),
    memory: new NoopMemoryManager(),
  };
}

describe("permission-engine type surface", () => {
  it("exports RiskLevel with the four documented values", () => {
    const all: RiskLevel[] = [
      "workspace_read",
      "workspace_write",
      "workspace_destructive",
      "network",
    ];
    expect(all).toHaveLength(4);
  });

  it("RuleVerdict has allow / ask / deny shapes", () => {
    const a: RuleVerdict = { kind: "allow" };
    const b: RuleVerdict = {
      kind: "ask",
      reason: "writes a file",
      risk: "workspace_write",
    };
    const c: RuleVerdict = { kind: "deny", reason: "outside workspace" };
    expect([a.kind, b.kind, c.kind]).toEqual(["allow", "ask", "deny"]);
  });

  it("PermissionRule signature accepts (call, ctx) and returns RuleVerdict", () => {
    const r: PermissionRule = (_call, _ctx) => ({ kind: "allow" });
    expect(typeof r).toBe("function");
  });

  it("AskResolver is structurally satisfiable", () => {
    const resolver: AskResolver = {
      async present(_request, _signal) {
        return "allow";
      },
    };
    expect(typeof resolver.present).toBe("function");
  });

  it("PermissionRequest carries a risk field", () => {
    const req: PermissionRequest = {
      id: "x",
      call: { id: "1", tool: "edit_file", input: {} },
      reason: "mutates file",
      risk: "workspace_write",
    };
    expect(req.risk).toBe("workspace_write");
  });

  it("AgentEvent includes permission.resolved", () => {
    const e: AgentEvent = {
      type: "permission.resolved",
      layer: "backend",
      id: "p1",
      decision: "allow",
    };
    expect(e.type).toBe("permission.resolved");
  });

  it("ToolResult.suggestion is optional", () => {
    const a: ToolResult = { ok: true, summary: "ok" };
    const b: ToolResult = {
      ok: false,
      error: { code: "permission_denied", message: "no", retryable: false },
      suggestion: "Try a read-only path.",
      summary: "denied",
    };
    expect(a.suggestion).toBeUndefined();
    expect(b.suggestion).toBe("Try a read-only path.");
  });

  it("PermissionDecision.ask includes a `decision` Promise", async () => {
    const decisionPromise: Promise<"allow" | "deny"> = Promise.resolve("allow");
    const d: import("./permission-engine.js").PermissionDecision = {
      kind: "ask",
      request: {
        id: "p1",
        call: { id: "1", tool: "x", input: {} },
        reason: "test",
        risk: "workspace_write",
      },
      decision: decisionPromise,
    };
    if (d.kind === "ask") {
      expect(await d.decision).toBe("allow");
    }
  });
});

describe("RulePermissionEngine — registration + non-ask paths", () => {
  it("default-allows when no rule is registered", async () => {
    const eng = new RulePermissionEngine({ ask: new FakeAskResolver() });
    const d = await eng.check(makeCall("anything"), makeCtx());
    expect(d.kind).toBe("allow");
  });

  it("returns allow when the rule says allow", async () => {
    const eng = new RulePermissionEngine({ ask: new FakeAskResolver() });
    eng.registerRule("read_file", () => ({ kind: "allow" }));
    const d = await eng.check(makeCall("read_file"), makeCtx());
    expect(d.kind).toBe("allow");
  });

  it("returns deny with the rule's reason when the rule says deny", async () => {
    const eng = new RulePermissionEngine({ ask: new FakeAskResolver() });
    eng.registerRule("write_thing", () => ({
      kind: "deny",
      reason: "outside workspace",
    }));
    const d = await eng.check(makeCall("write_thing"), makeCtx());
    expect(d.kind).toBe("deny");
    if (d.kind === "deny") expect(d.reason).toBe("outside workspace");
  });

  it("threads the ask verdict's code into the PermissionRequest", async () => {
    // Display surfaces localize the summary by this code (GUI approval
    // panel, user bug 2026-07-23); reason stays the neutral machine text.
    const eng = new RulePermissionEngine({ ask: new FakeAskResolver() });
    eng.registerRule("run_command", () => ({
      kind: "ask",
      reason: "unrecognized command — review carefully",
      risk: "workspace_write",
      code: "command_ask_unknown",
    }));
    const d = await eng.check(makeCall("run_command"), makeCtx());
    expect(d.kind).toBe("ask");
    if (d.kind === "ask") expect(d.request.code).toBe("command_ask_unknown");
  });

  it("awaits async rules", async () => {
    const eng = new RulePermissionEngine({ ask: new FakeAskResolver() });
    eng.registerRule("slow", async () => {
      await new Promise((r) => setTimeout(r, 1));
      return { kind: "deny", reason: "slow no" };
    });
    const d = await eng.check(makeCall("slow"), makeCtx());
    expect(d.kind).toBe("deny");
  });

  it("registerRule throws on duplicate registration", () => {
    const eng = new RulePermissionEngine({ ask: new FakeAskResolver() });
    eng.registerRule("dup", () => ({ kind: "allow" }));
    expect(() => eng.registerRule("dup", () => ({ kind: "allow" }))).toThrow(
      /duplicate/i,
    );
  });

  it("resolve() is a no-op (does not throw)", () => {
    const eng = new RulePermissionEngine({ ask: new FakeAskResolver() });
    expect(() => eng.resolve("nope", "allow")).not.toThrow();
  });
});

describe("RulePermissionEngine — ask path", () => {
  it("returns kind:'ask' with request.risk and a Promise<allow|deny> decision", async () => {
    const ask = new FakeAskResolver();
    const eng = new RulePermissionEngine({ ask });
    eng.registerRule("edit_file", () => ({
      kind: "ask",
      reason: "writes file",
      risk: "workspace_write",
    }));
    const d = await eng.check(makeCall("edit_file"), makeCtx());
    expect(d.kind).toBe("ask");
    if (d.kind !== "ask") return;
    expect(d.request.risk).toBe("workspace_write");
    expect(d.request.reason).toBe("writes file");
    expect(d.request.call.tool).toBe("edit_file");
    expect(typeof d.request.id).toBe("string");
    expect(d.request.id).not.toBe("");

    expect(ask.pending).toHaveLength(1);
    expect(ask.pending[0]?.request.id).toBe(d.request.id);

    ask.allow();
    await expect(d.decision).resolves.toBe("allow");
  });

  it("decision Promise resolves to 'deny' when resolver denies", async () => {
    const ask = new FakeAskResolver();
    const eng = new RulePermissionEngine({ ask });
    eng.registerRule("net", () => ({
      kind: "ask",
      reason: "external network",
      risk: "network",
    }));
    const d = await eng.check(makeCall("net"), makeCtx());
    if (d.kind !== "ask") throw new Error("expected ask");
    ask.deny();
    await expect(d.decision).resolves.toBe("deny");
  });

  it("decision Promise rejects when ctx signal aborts", async () => {
    const ask = new FakeAskResolver();
    const eng = new RulePermissionEngine({ ask });
    eng.registerRule("net", () => ({
      kind: "ask",
      reason: "external network",
      risk: "network",
    }));
    const ac = new AbortController();
    const ctx = { ...makeCtx(), signal: ac.signal };
    const d = await eng.check(makeCall("net"), ctx);
    if (d.kind !== "ask") throw new Error("expected ask");
    ac.abort(new Error("interrupted"));
    await expect(d.decision).rejects.toThrow("interrupted");
  });

  it("each ask gets a fresh id (no collisions across calls)", async () => {
    const ask = new FakeAskResolver();
    const eng = new RulePermissionEngine({ ask });
    eng.registerRule("x", () => ({
      kind: "ask",
      reason: "r",
      risk: "workspace_write",
    }));
    const d1 = await eng.check(makeCall("x"), makeCtx());
    const d2 = await eng.check(makeCall("x"), makeCtx());
    if (d1.kind !== "ask" || d2.kind !== "ask") throw new Error();
    expect(d1.request.id).not.toBe(d2.request.id);
    ask.allow(0);
    ask.allow(1);
  });

  it("propagates diff and files from RuleVerdict.ask into PermissionRequest", async () => {
    const ask = new FakeAskResolver();
    const eng = new RulePermissionEngine({ ask });
    eng.registerRule("rich_ask", () => ({
      kind: "ask",
      reason: "writes foo.ts",
      risk: "workspace_write",
      diff: "--- a/foo.ts\n+++ b/foo.ts\n@@ -1 +1 @@\n-old\n+new\n",
      files: ["foo.ts"],
    }));
    const d = await eng.check(makeCall("rich_ask"), makeCtx());
    expect(d.kind).toBe("ask");
    if (d.kind !== "ask") throw new Error();
    expect(d.request.diff).toContain("+new");
    expect(d.request.files).toEqual(["foo.ts"]);
    ask.allow();
  });
});
