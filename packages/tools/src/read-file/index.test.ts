import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type AgentEvent,
  BackgroundHost,
  InMemoryEventBus,
  NoopMemoryManager,
  ReadLedger,
} from "@herta/core";
import { afterEach, describe, expect, it } from "vitest";
import { mkTmpWorkspace, type TmpWorkspace } from "../testing/tmp-workspace.js";
import { readFileTool } from "./index.js";

let ws: TmpWorkspace;
afterEach(async () => {
  if (ws) await ws.cleanup();
});

function ctx(workspaceRoot: string, reads = new ReadLedger()) {
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
const noopProgress = () => {};

describe("readFileTool", () => {
  it("can follow harness-evidence pointers under .herta/tool-results and .herta/logs (ADR 0025 slice 2)", async () => {
    ws = await mkTmpWorkspace({
      ".herta/tool-results/task-1/call_01.json": '{"data":{"diff":"big"}}',
      ".herta/logs/run.log": "stdout line\n",
      ".herta/memory/project.jsonl": "{}",
    });
    const tool = readFileTool();
    const evidence = await tool.run(
      {
        id: "1",
        tool: "read_file",
        input: { path: ".herta/tool-results/task-1/call_01.json" },
      },
      ctx(ws.root),
      noopProgress,
    );
    expect(evidence.ok).toBe(true);
    expect((evidence.data as { content: string }).content).toContain("diff");
    const log = await tool.run(
      { id: "2", tool: "read_file", input: { path: ".herta/logs/run.log" } },
      ctx(ws.root),
      noopProgress,
    );
    expect(log.ok).toBe(true);
    // The rest of .herta stays denied for read_file too.
    const memory = await tool.run(
      {
        id: "3",
        tool: "read_file",
        input: { path: ".herta/memory/project.jsonl" },
      },
      ctx(ws.root),
      noopProgress,
    );
    expect(memory.ok).toBe(false);
    expect(memory.error?.code).toBe("path_denied");
  });

  it("returns cat -n formatted content with default offset/limit", async () => {
    ws = await mkTmpWorkspace({ "a.txt": "alpha\nbeta\ngamma\n" });
    const tool = readFileTool();
    const r = await tool.run(
      { id: "1", tool: "read_file", input: { path: "a.txt" } },
      ctx(ws.root),
      noopProgress,
    );
    expect(r.ok).toBe(true);
    const data = r.data as {
      content: string;
      totalLines: number;
      returnedRange: [number, number];
      encoding: string;
    };
    expect(data.totalLines).toBe(3);
    expect(data.returnedRange).toEqual([1, 3]);
    expect(data.encoding).toBe("utf-8");
    expect(data.content).toContain("1\t");
    expect(data.content).toContain("alpha");
    expect(r.summary).toContain("read a.txt");
  });

  it("honors offset and limit", async () => {
    const lines = Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join(
      "\n",
    );
    ws = await mkTmpWorkspace({ "long.txt": lines });
    const tool = readFileTool();
    const r = await tool.run(
      {
        id: "1",
        tool: "read_file",
        input: { path: "long.txt", offset: 4, limit: 3 },
      },
      ctx(ws.root),
      noopProgress,
    );
    expect(r.ok).toBe(true);
    const data = r.data as { returnedRange: [number, number]; content: string };
    expect(data.returnedRange).toEqual([4, 6]);
    expect(data.content).toContain("line4");
    expect(data.content).toContain("line6");
    expect(data.content).not.toContain("line3");
    expect(data.content).not.toContain("line7");
  });

  it("returns empty content + accurate summary for empty file", async () => {
    ws = await mkTmpWorkspace({ "empty.txt": "" });
    const tool = readFileTool();
    const r = await tool.run(
      { id: "1", tool: "read_file", input: { path: "empty.txt" } },
      ctx(ws.root),
      noopProgress,
    );
    expect(r.ok).toBe(true);
    const data = r.data as { content: string; totalLines: number };
    expect(data.content).toBe("");
    expect(data.totalLines).toBe(0);
    expect(r.summary).toContain("empty");
  });

  it("strips UTF-8 BOM", async () => {
    ws = await mkTmpWorkspace({
      "bom.txt": "﻿hello\n",
    });
    const tool = readFileTool();
    const r = await tool.run(
      { id: "1", tool: "read_file", input: { path: "bom.txt" } },
      ctx(ws.root),
      noopProgress,
    );
    expect(r.ok).toBe(true);
    const data = r.data as { content: string };
    expect(data.content.includes("﻿")).toBe(false);
    expect(data.content).toContain("hello");
  });

  it("returns binary_file when first 4KB contains NUL", async () => {
    const buf = new Uint8Array(100);
    buf[10] = 0;
    ws = await mkTmpWorkspace({ "bin.dat": buf });
    const tool = readFileTool();
    const r = await tool.run(
      { id: "1", tool: "read_file", input: { path: "bin.dat" } },
      ctx(ws.root),
      noopProgress,
    );
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("binary_file");
    expect(r.error?.retryable).toBe(false);
  });

  it("returns file_too_large for files over 10MB without reading them", async () => {
    const big = new Uint8Array(11 * 1024 * 1024);
    ws = await mkTmpWorkspace({ "big.bin": big });
    const tool = readFileTool();
    const r = await tool.run(
      { id: "1", tool: "read_file", input: { path: "big.bin" } },
      ctx(ws.root),
      noopProgress,
    );
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("file_too_large");
  });

  it("returns not_found for missing files", async () => {
    ws = await mkTmpWorkspace({});
    const tool = readFileTool();
    const r = await tool.run(
      { id: "1", tool: "read_file", input: { path: "missing.txt" } },
      ctx(ws.root),
      noopProgress,
    );
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("not_found");
  });

  it("returns invalid_input for bad input shape", async () => {
    ws = await mkTmpWorkspace({});
    const tool = readFileTool();
    const r = await tool.run(
      { id: "1", tool: "read_file", input: { offset: -1 } },
      ctx(ws.root),
      noopProgress,
    );
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("invalid_input");
  });

  it("returns path_denied for .env", async () => {
    ws = await mkTmpWorkspace({ ".env": "S=1\n" });
    const tool = readFileTool();
    const r = await tool.run(
      { id: "1", tool: "read_file", input: { path: ".env" } },
      ctx(ws.root),
      noopProgress,
    );
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("path_denied");
  });

  it("exposes JSON Schema via schema().inputSchema", async () => {
    const tool = readFileTool();
    const schema = tool.schema();
    expect(schema.name).toBe("read_file");
    expect(schema.description.length).toBeGreaterThan(0);
    expect(schema.inputSchema).toBeDefined();
    expect(typeof schema.inputSchema).toBe("object");
  });

  it("right-aligns line numbers based on returned max, not total file size", async () => {
    const many = Array.from({ length: 1500 }, (_, i) => `L${i + 1}`).join("\n");
    ws = await mkTmpWorkspace({ "many.txt": many });
    const tool = readFileTool();
    const r = await tool.run(
      {
        id: "1",
        tool: "read_file",
        input: { path: "many.txt", offset: 1, limit: 5 },
      },
      ctx(ws.root),
      noopProgress,
    );
    expect(r.ok).toBe(true);
    const data = r.data as { content: string };
    expect(data.content.startsWith("1\t")).toBe(true);
  });

  it("records sha256 of full file bytes in the ledger on success", async () => {
    ws = await mkTmpWorkspace({ "a.txt": "alpha\nbeta\n" });
    const tool = readFileTool();
    const reads = new ReadLedger();
    const r = await tool.run(
      { id: "1", tool: "read_file", input: { path: "a.txt" } },
      ctx(ws.root, reads),
      noopProgress,
    );
    expect(r.ok).toBe(true);
    const abs = join(ws.root, "a.txt");
    const buf = await readFile(abs);
    const expectedSha = createHash("sha256").update(buf).digest("hex");
    const entry = reads.get(abs);
    expect(entry?.sha256).toBe(expectedSha);
  });
});
