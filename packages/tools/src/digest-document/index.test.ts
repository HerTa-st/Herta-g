import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type AgentEvent,
  BackgroundHost,
  FindingsLedger,
  InMemoryEventBus,
  NoopMemoryManager,
  ReadLedger,
} from "@herta/core";
import { afterEach, describe, expect, it } from "vitest";
import { reportFindingTool } from "../report-finding/index.js";
import { mkTmpWorkspace, type TmpWorkspace } from "../testing/tmp-workspace.js";
import {
  type DigestDocumentData,
  type DigestModel,
  digestDocumentTool,
  digestSidecarFor,
  MAX_DIGEST_CHUNKS,
} from "./index.js";

let ws: TmpWorkspace;
afterEach(async () => {
  if (ws) await ws.cleanup();
});

const noop = () => {};
function ctxFor(workspaceRoot: string, signal?: AbortSignal) {
  return {
    sessionId: "s",
    signal: signal ?? new AbortController().signal,
    workspaceRoot,
    reads: new ReadLedger(),
    bg: new BackgroundHost(),
    bus: new InMemoryEventBus<AgentEvent>(),
    memory: new NoopMemoryManager(),
    findings: new FindingsLedger(),
  };
}
const call = (path: string) => ({
  id: "c1",
  tool: "digest_document",
  input: { path },
});

/** A fake side model that answers with the range it was given, and records
 *  every call so the tests can see what the harness sent. */
function fakeModel(opts: { failOn?: (user: string) => boolean } = {}) {
  const calls: { system: string; user: string }[] = [];
  let inFlight = 0;
  let peak = 0;
  const model: DigestModel = async ({ system, user }) => {
    calls.push({ system, user });
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight -= 1;
    if (opts.failOn?.(user)) throw new Error("boom");
    if (/总览|overview/i.test(system)) return "总览第一行\n总览第二行";
    const range = /范围：(.*)|Range: (.*)/.exec(user);
    return `- 这一段是 ${range?.[1] ?? range?.[2]}\n\n要点二`;
  };
  return { model, calls, peak: () => peak };
}

/** A 4-page "PDF text" with markers, ~300 chars/page. */
function pdfText(pages = 4): string {
  return Array.from(
    { length: pages },
    (_, i) => `── 第 ${i + 1} 页 ──\n${`第${i + 1}页的正文。`.repeat(25)}`,
  ).join("\n\n");
}

describe("digest_document (ADR 0043)", () => {
  it("chunks an attached document, summarizes every chunk, reduces an overview, and writes the sidecar", async () => {
    const rel = ".herta/attachments/s1/book-ab12cd34.pdf.txt";
    ws = await mkTmpWorkspace({ [rel]: pdfText(4) });
    const fake = fakeModel();
    const tool = digestDocumentTool({ model: fake.model, chunkChars: 700 });
    const r = await tool.run(call(rel), ctxFor(ws.root), noop);
    expect(r.ok).toBe(true);
    const data = r.data as DigestDocumentData;
    expect(data.digestPath).toBe(
      ".herta/attachments/s1/book-ab12cd34.pdf.digest.txt",
    );
    expect(data.chunks).toBe(2);
    expect(data.cached).toBe(false);
    expect(data.failed).toBe(0);
    expect(data.overview).toBe("总览第一行\n总览第二行");
    // One call per chunk + the reduce; the chunk prompts carry the range
    // with pages, the reduce prompt carries every entry.
    expect(fake.calls).toHaveLength(3);
    expect(fake.calls[0]?.user).toContain("范围：L1–L9（第 1–3 页）");
    expect(fake.calls[2]?.user).toContain("## L1–L9（第 1–3 页）");
    expect(fake.calls[2]?.user).toContain("## L10–L11（第 4 页）");
    // The sidecar: header (labeled model-generated), overview, entries.
    const stored = readFileSync(
      join(ws.root, ...data.digestPath.split("/")),
      "utf8",
    );
    expect(stored.split("\n")[0]).toBe(
      "# 文档摘要 · book-ab12cd34.pdf.txt · 共 2 段 · 模型生成的导航摘要——引用前请回读原文对应行",
    );
    expect(stored).toContain(
      "总览第一行\n总览第二行\n\n## L1–L9（第 1–3 页）\n这一段是 L1–L9（第 1–3 页）\n要点二",
    );
    // Bullets the prompt forbade are stripped; the model sees the digest.
    expect(stored).not.toContain("- 这一段");
    expect(r.modelText).toBe(stored);
    expect(r.summary).toBe(`digested ${rel} → ${data.digestPath} (2 chunks)`);
  });

  it("a second call returns the stored digest without any model call", async () => {
    const rel = ".herta/attachments/s1/book-ab12cd34.pdf.txt";
    ws = await mkTmpWorkspace({ [rel]: pdfText(2) });
    const fake = fakeModel();
    const tool = digestDocumentTool({ model: fake.model });
    await tool.run(call(rel), ctxFor(ws.root), noop);
    const n = fake.calls.length;
    const again = await tool.run(call(rel), ctxFor(ws.root), noop);
    expect(fake.calls).toHaveLength(n);
    const data = again.data as DigestDocumentData;
    expect(data.cached).toBe(true);
    expect(data.chunks).toBe(1);
    expect(data.overview).toBe("总览第一行\n总览第二行");
    expect(
      again.modelText?.startsWith("（已有摘要，直接返回）\n# 文档摘要"),
    ).toBe(true);
    expect(again.summary).toContain("cached");
  });

  it("runs chunk calls in parallel, bounded by the concurrency", async () => {
    const rel = ".herta/attachments/s1/long-ab12cd34.pdf.txt";
    ws = await mkTmpWorkspace({ [rel]: pdfText(12) });
    const fake = fakeModel();
    const tool = digestDocumentTool({
      model: fake.model,
      chunkChars: 400,
      concurrency: 3,
    });
    const r = await tool.run(call(rel), ctxFor(ws.root), noop);
    expect((r.data as DigestDocumentData).chunks).toBeGreaterThan(6);
    expect(fake.peak()).toBe(3);
  });

  it("refuses anything that is not an attachment — a repo file, a sidecar, an outside path — and says what to do instead", async () => {
    ws = await mkTmpWorkspace({
      "notes.md": "hello",
      ".herta/attachments/s1/x-ab12cd34.pdf.digest.txt": "# old",
    });
    const tool = digestDocumentTool({ model: fakeModel().model });
    const repo = await tool.run(call("notes.md"), ctxFor(ws.root), noop);
    expect(repo.ok).toBe(false);
    expect(repo.error?.code).toBe("not_an_attachment");
    expect(repo.suggestion).toContain("grep");
    const sidecar = await tool.run(
      call(".herta/attachments/s1/x-ab12cd34.pdf.digest.txt"),
      ctxFor(ws.root),
      noop,
    );
    expect(sidecar.error?.code).toBe("not_an_attachment");
    const outside = await tool.run(
      call("../elsewhere.txt"),
      ctxFor(ws.root),
      noop,
    );
    expect(outside.ok).toBe(false);
    expect(outside.error?.code).toBe("path_outside_workspace");
    const missing = await tool.run(
      call(".herta/attachments/s1/nope-ab12cd34.pdf.txt"),
      ctxFor(ws.root),
      noop,
    );
    expect(missing.error?.code).toBe("not_found");
  });

  it("with no side model configured it is `unavailable`, not absent", async () => {
    const rel = ".herta/attachments/s1/a-ab12cd34.md";
    ws = await mkTmpWorkspace({ [rel]: "x" });
    const tool = digestDocumentTool({ model: null });
    const r = await tool.run(call(rel), ctxFor(ws.root), noop);
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("unavailable");
    expect(existsSync(join(ws.root, ...digestSidecarFor(rel).split("/")))).toBe(
      false,
    );
  });

  it("a failed chunk is marked in the sidecar; a majority of failures fails the call and writes nothing", async () => {
    const rel = ".herta/attachments/s1/b-ab12cd34.pdf.txt";
    ws = await mkTmpWorkspace({ [rel]: pdfText(4) });
    // One chunk fails (both attempts) → marked, the rest stands.
    const one = fakeModel({ failOn: (u) => u.includes("L10–L11") });
    const tool = digestDocumentTool({ model: one.model, chunkChars: 700 });
    const r = await tool.run(call(rel), ctxFor(ws.root), noop);
    expect(r.ok).toBe(true);
    expect((r.data as DigestDocumentData).failed).toBe(1);
    expect(r.modelText).toContain("（该段摘要失败——请直接读取原文）");
    expect(r.summary).toContain("1 failed");
    // Every chunk fails → no digest, a retryable error, no sidecar.
    const rel2 = ".herta/attachments/s1/c-ab12cd34.pdf.txt";
    writeFileSync(
      join(ws.root, ".herta", "attachments", "s1", "c-ab12cd34.pdf.txt"),
      pdfText(4),
    );
    const all = fakeModel({ failOn: (u) => u.includes("范围") });
    const tool2 = digestDocumentTool({ model: all.model, chunkChars: 700 });
    const r2 = await tool2.run(call(rel2), ctxFor(ws.root), noop);
    expect(r2.ok).toBe(false);
    expect(r2.error?.code).toBe("digest_failed");
    expect(r2.error?.retryable).toBe(true);
    expect(
      existsSync(join(ws.root, ...digestSidecarFor(rel2).split("/"))),
    ).toBe(false);
  });

  it("a document over the chunk cap is refused whole, pointing at the outline and grep", async () => {
    const rel = ".herta/attachments/s1/huge-ab12cd34.pdf.txt";
    ws = await mkTmpWorkspace({ [rel]: pdfText(MAX_DIGEST_CHUNKS + 5) });
    const fake = fakeModel();
    const tool = digestDocumentTool({ model: fake.model, chunkChars: 300 });
    const r = await tool.run(call(rel), ctxFor(ws.root), noop);
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("too_large");
    expect(fake.calls).toHaveLength(0);
  });

  it("stops on abort and writes nothing", async () => {
    const rel = ".herta/attachments/s1/d-ab12cd34.pdf.txt";
    ws = await mkTmpWorkspace({ [rel]: pdfText(6) });
    const ac = new AbortController();
    const model: DigestModel = async () => {
      ac.abort();
      return "x";
    };
    const tool = digestDocumentTool({ model, chunkChars: 500 });
    await expect(
      tool.run(call(rel), ctxFor(ws.root, ac.signal), noop),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(existsSync(join(ws.root, ...digestSidecarFor(rel).split("/")))).toBe(
      false,
    );
  });

  it("the summarize hook names the path for the record's `Digesting <path>` row", () => {
    const tool = digestDocumentTool({ model: null });
    expect(
      tool.summarize?.({ path: "a/b.pdf.txt" }, { workspaceRoot: "" }),
    ).toBe("a/b.pdf.txt");
    expect(tool.summarize?.({}, { workspaceRoot: "" })).toBeUndefined();
  });

  it("report_finding refuses a cite INTO a digest sidecar (the digest is model-generated) and accepts the source it points at", async () => {
    const src = ".herta/attachments/s1/e-ab12cd34.pdf.txt";
    ws = await mkTmpWorkspace({ [src]: pdfText(2) });
    mkdirSync(join(ws.root, ".herta", "attachments", "s1"), {
      recursive: true,
    });
    writeFileSync(
      join(ws.root, ...digestSidecarFor(src).split("/")),
      "# 文档摘要 · e · 共 1 段\n总览\n\n## L1–L4\n摘要\n",
    );
    const finding = reportFindingTool();
    const ctx = ctxFor(ws.root);
    const bad = await finding.run(
      {
        id: "f1",
        tool: "report_finding",
        input: {
          claim: "the digest says so",
          cites: [`${digestSidecarFor(src)}:4`],
        },
      },
      ctx,
      noop,
    );
    expect(bad.ok).toBe(false);
    expect(bad.error?.code).toBe("invalid_cite");
    expect(bad.error?.message).toContain("model-generated");
    const good = await finding.run(
      {
        id: "f2",
        tool: "report_finding",
        input: { claim: "the source says so", cites: [`${src}:2`] },
      },
      ctx,
      noop,
    );
    expect(good.ok).toBe(true);
  });
});
