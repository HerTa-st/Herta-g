import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
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
import { writeNewFileTool } from "./index.js";

let ws: TmpWorkspace;
afterEach(async () => {
  if (ws) await ws.cleanup();
});

const noopProgress = () => {};

function ctxFor(workspaceRoot: string, reads = new ReadLedger()) {
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

describe("writeNewFileTool", () => {
  it("happy path: writes file, ledger updated, summary correct", async () => {
    ws = await mkTmpWorkspace({});
    const reads = new ReadLedger();
    const tool = writeNewFileTool();
    const r = await tool.run(
      {
        id: "1",
        tool: "write_new_file",
        input: { path: "new.txt", content: "hello\nworld\n" },
      },
      ctxFor(ws.root, reads),
      noopProgress,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error();
    const data = r.data as {
      relPath: string;
      bytesWritten: number;
      sha256: string;
    };
    expect(data.relPath).toBe("new.txt");
    expect(data.bytesWritten).toBe(12);
    const abs = join(ws.root, "new.txt");
    const onDisk = await readFile(abs, "utf-8");
    expect(onDisk).toBe("hello\nworld\n");
    const expectedSha = createHash("sha256")
      .update(Buffer.from(onDisk))
      .digest("hex");
    expect(data.sha256).toBe(expectedSha);
    expect(reads.get(abs)?.sha256).toBe(expectedSha);
    expect(r.summary).toContain("new.txt");
    expect(r.summary).toContain("12 bytes");
  });

  it("mkdir -p creates parent directories", async () => {
    ws = await mkTmpWorkspace({});
    const tool = writeNewFileTool();
    const r = await tool.run(
      {
        id: "1",
        tool: "write_new_file",
        input: { path: "a/b/c/new.ts", content: "x" },
      },
      ctxFor(ws.root),
      noopProgress,
    );
    expect(r.ok).toBe(true);
    const onDisk = await readFile(join(ws.root, "a/b/c/new.ts"), "utf-8");
    expect(onDisk).toBe("x");
  });

  it("TOCTOU: file appears between rule and run → file_exists, no overwrite", async () => {
    ws = await mkTmpWorkspace({});
    const abs = join(ws.root, "race.txt");
    await writeFile(abs, "raced");
    const tool = writeNewFileTool();
    const r = await tool.run(
      {
        id: "1",
        tool: "write_new_file",
        input: { path: "race.txt", content: "new content" },
      },
      ctxFor(ws.root),
      noopProgress,
    );
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("file_exists");
    const onDisk = await readFile(abs, "utf-8");
    expect(onDisk).toBe("raced");
  });

  it("empty content creates a 0-byte file", async () => {
    ws = await mkTmpWorkspace({});
    const tool = writeNewFileTool();
    const r = await tool.run(
      {
        id: "1",
        tool: "write_new_file",
        input: { path: "empty.txt", content: "" },
      },
      ctxFor(ws.root),
      noopProgress,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error();
    const data = r.data as { bytesWritten: number };
    expect(data.bytesWritten).toBe(0);
    const onDisk = await readFile(join(ws.root, "empty.txt"), "utf-8");
    expect(onDisk).toBe("");
  });

  it("rejects content > 10MB with file_too_large", async () => {
    ws = await mkTmpWorkspace({});
    const tool = writeNewFileTool();
    const big = "x".repeat(10 * 1024 * 1024 + 1);
    const r = await tool.run(
      {
        id: "1",
        tool: "write_new_file",
        input: { path: "big.txt", content: big },
      },
      ctxFor(ws.root),
      noopProgress,
    );
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("file_too_large");
  });

  it("rejects .git paths with path_denied", async () => {
    ws = await mkTmpWorkspace({});
    const tool = writeNewFileTool();
    const r = await tool.run(
      {
        id: "1",
        tool: "write_new_file",
        input: { path: ".git/HEAD", content: "x" },
      },
      ctxFor(ws.root),
      noopProgress,
    );
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("path_denied");
  });

  it("does not leave temp files on success", async () => {
    ws = await mkTmpWorkspace({});
    await mkdir(join(ws.root, "sub"));
    const tool = writeNewFileTool();
    await tool.run(
      {
        id: "1",
        tool: "write_new_file",
        input: { path: "sub/new.txt", content: "x" },
      },
      ctxFor(ws.root),
      noopProgress,
    );
    const entries = await readdir(join(ws.root, "sub"));
    const stragglers = entries.filter((n) => n.includes("herta-tmp"));
    expect(stragglers).toHaveLength(0);
  });
});
