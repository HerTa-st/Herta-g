import { MessageChannel, type MessagePort } from "node:worker_threads";
import { afterEach, describe, expect, it } from "vitest";
import { extractDocumentText } from "./document-text.js";
import {
  type DocumentWorker,
  extractDocument,
  serveDocumentExtraction,
  setDocumentExtractor,
  workerDocumentExtractor,
} from "./document-worker.js";
import {
  makePdf,
  type PdfPictureFixture,
} from "./testing/document-fixtures.js";

// A page with room under (a) and a small picture drawn there, as the
// extraction tests draw a handout's formula.
const underA: PdfPictureFixture = {
  at: [72, 610, 120, 40],
  width: 12,
  height: 10,
  kind: "rgb",
};
const pdf = (): Buffer =>
  makePdf([["Question 1.", "(a)", "(b)"], ["Page two"]], {
    lineGap: 60,
    pictures: [[underA], []],
  });

/** A worker stand-in over a MessageChannel: the "worker" end is served by
 *  the real `serveDocumentExtraction`, in this thread. */
function channelWorker(): {
  readonly worker: DocumentWorker;
  readonly inside: MessagePort;
  readonly die: () => void;
} {
  const { port1, port2 } = new MessageChannel();
  serveDocumentExtraction(port2);
  const exits: Array<(code: number) => void> = [];
  const worker: DocumentWorker = {
    postMessage: (value, transfer) =>
      port1.postMessage(value, transfer as ArrayBuffer[] | undefined),
    on: ((event: string, listener: (value: unknown) => void) => {
      if (event === "message") port1.on("message", listener);
      if (event === "exit") exits.push(listener as (code: number) => void);
      return worker;
    }) as DocumentWorker["on"],
    terminate: async () => {
      port1.close();
      port2.close();
      return 0;
    },
  };
  return {
    worker,
    inside: port2,
    die: () => {
      port1.close();
      port2.close();
      for (const exit of exits) exit(1);
    },
  };
}

afterEach(() => {
  setDocumentExtractor(null);
});

describe("reading a document on a worker (owner 2026-10-16)", () => {
  it("answers as the in-process reader does: the text, the pages, the pictures as Buffers, and each page's progress", async () => {
    const { worker } = channelWorker();
    const reader = workerDocumentExtractor(() => worker);
    const progress: Array<[number, number]> = [];
    const bytes = pdf();
    const r = await reader.extract("pdf", bytes, {
      pictures: true,
      lang: "en",
      onPage: (done, total) => progress.push([done, total]),
    });
    const local = await extractDocumentText("pdf", pdf(), {
      pictures: true,
      lang: "en",
    });
    expect(r.ok).toBe(true);
    if (!r.ok || !local.ok) return;
    expect(r.text).toBe(local.text);
    expect(r.pages).toBe(2);
    expect(r.pictures).toHaveLength(1);
    // The PNG crossed as a Uint8Array; the ingest reads a Buffer.
    expect(Buffer.isBuffer(r.pictures?.[0]?.png)).toBe(true);
    expect(
      r.pictures?.[0]?.png.equals(local.pictures?.[0]?.png ?? Buffer.alloc(0)),
    ).toBe(true);
    expect(progress).toEqual([
      [0, 2],
      [1, 2],
      [2, 2],
    ]);
    // The caller's bytes are its own: only a copy crossed.
    expect(bytes.byteLength).toBeGreaterThan(0);
    await reader.close();
  });

  it("a worker that dies answers what it held with parse_error, and the next document starts a new one", async () => {
    const started: Array<ReturnType<typeof channelWorker>> = [];
    const reader = workerDocumentExtractor(() => {
      const w = channelWorker();
      started.push(w);
      return w.worker;
    });
    const held = reader.extract("pdf", pdf(), {});
    started[0]?.die();
    expect(await held).toEqual({ ok: false, reason: "parse_error" });
    const next = await reader.extract("pdf", pdf(), {});
    expect(next.ok).toBe(true);
    expect(started).toHaveLength(2);
    await reader.close();
  });

  it("a worker that cannot start leaves the document to the in-process reader", async () => {
    const reader = workerDocumentExtractor(() => {
      throw new Error("no worker file");
    });
    const r = await reader.extract("pdf", pdf(), {});
    expect(r.ok).toBe(true);
  });

  it("the ingest reads through the installed reader, and in-process without one", async () => {
    const seen: string[] = [];
    setDocumentExtractor(async (format) => {
      seen.push(format);
      return { ok: false, reason: "unsupported" };
    });
    expect(await extractDocument("pdf", pdf())).toEqual({
      ok: false,
      reason: "unsupported",
    });
    expect(seen).toEqual(["pdf"]);
    setDocumentExtractor(null);
    expect((await extractDocument("pdf", pdf())).ok).toBe(true);
  });
});
