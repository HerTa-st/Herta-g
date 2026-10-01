import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TerminalRecord, TerminalRecordBlock } from "@herta/core";
import { afterEach, describe, expect, it } from "vitest";
import type { ImageCaptioner } from "./attachments.js";
import { SessionAttachments } from "./session-attachments.js";
import { makePdf } from "./testing/document-fixtures.js";
import { removeTmpDir } from "./testing/tmp-workspace.js";

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await removeTmpDir(d);
});

/** A one-page handout with one picture under (a). */
function handout(shade: number): Buffer {
  return makePdf([["Question 1.", "(a)", "(b)"]], {
    lineGap: 60,
    pictures: [
      [
        {
          at: [72, 610, 120, 40],
          width: 12,
          height: 10,
          kind: "rgb",
          data: new Uint8Array(12 * 10 * 3).fill(shade),
        },
      ],
    ],
  });
}

describe("SessionAttachments — progress while a batch is read (2026-10-01)", () => {
  it("reports each file in order: its pages, its transcripts as each finishes, then done — and a throwing listener costs nothing", async () => {
    const ws = mkdtempSync(join(tmpdir(), "herta-attach-progress-"));
    const src = mkdtempSync(join(tmpdir(), "herta-attach-progress-src-"));
    dirs.push(ws, src);
    const record: TerminalRecordBlock[] = [];
    const attachments = new SessionAttachments({
      sessionId: "s1",
      lang: "zh",
      wsHolder: { current: ws },
      captionImage: async () => "\\mathbf{w}",
      turnInFlight: () => false,
      driver: {
        getRecord: () => record as TerminalRecord,
        appendSystemBlock: (b: TerminalRecordBlock) => {
          record.push(b);
        },
        replaceBlockAt: (i: number, b: TerminalRecordBlock) => {
          record[i] = b;
        },
      } as never,
      onAppended: () => {},
      onReplaced: () => {},
    });
    writeFileSync(join(src, "handout.pdf"), handout(30));
    writeFileSync(join(src, "notes.md"), "# notes\n");
    const seen: string[] = [];
    const r = await attachments.attachFiles(
      [join(src, "handout.pdf"), join(src, "notes.md")],
      (p) => {
        seen.push(`${p.index}:${p.stage}:${p.done}/${p.total}`);
        throw new Error("a broken listener");
      },
    );
    expect(r.ok).toBe(true);
    expect(record).toHaveLength(2);
    expect(seen).toEqual([
      "0:pages:0/0", // the file is being read now
      "0:pages:0/1", // the PDF opened: one page
      "0:pages:1/1",
      "0:transcripts:0/1",
      "0:transcripts:1/1",
      "0:done:0/0",
      "1:pages:0/0", // the second file's turn
      "1:done:0/0",
    ]);
  });
});

describe("SessionAttachments — the PDF-picture switch (2026-10-01)", () => {
  it("reads the user's switch at EACH attach: off sends nothing to the instrument, on transcribes", async () => {
    const ws = mkdtempSync(join(tmpdir(), "herta-attach-switch-"));
    const src = mkdtempSync(join(tmpdir(), "herta-attach-switch-src-"));
    dirs.push(ws, src);
    const calls: unknown[] = [];
    const caption: ImageCaptioner = async (req) => {
      calls.push(req);
      return "\\mathbf{w}";
    };
    let enabled = false;
    const record: TerminalRecordBlock[] = [];
    const attachments = new SessionAttachments({
      sessionId: "s1",
      lang: "zh",
      wsHolder: { current: ws },
      captionImage: caption,
      transcribePdfPictures: () => enabled,
      turnInFlight: () => false,
      driver: {
        getRecord: () => record as TerminalRecord,
        appendSystemBlock: (b: TerminalRecordBlock) => {
          record.push(b);
        },
        replaceBlockAt: (i: number, b: TerminalRecordBlock) => {
          record[i] = b;
        },
      } as never,
      onAppended: () => {},
      onReplaced: () => {},
    });
    const storedText = (rel: string): string =>
      readFileSync(join(ws, ...rel.split("/")), "utf8");

    writeFileSync(join(src, "off.pdf"), handout(10));
    const off = await attachments.attachFiles([join(src, "off.pdf")]);
    if (!off.ok) throw new Error(off.reason);
    expect(calls).toHaveLength(0);
    expect(storedText(off.files[0]?.path ?? "")).toContain(
      "（未转写，可用 view_image 查看原图）",
    );

    enabled = true; // the switch flipped in Settings — no new session needed
    writeFileSync(join(src, "on.pdf"), handout(20));
    const on = await attachments.attachFiles([join(src, "on.pdf")]);
    if (!on.ok) throw new Error(on.reason);
    expect(calls).toHaveLength(1);
    expect(storedText(on.files[0]?.path ?? "")).toContain(
      "自动转写：\\mathbf{w}",
    );
  });
});
