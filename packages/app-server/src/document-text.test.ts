import { describe, expect, it, vi } from "vitest";
import {
  extractDocumentText,
  MAX_OUTLINE_DEPTH,
  MAX_OUTLINE_ENTRIES,
  MAX_PDF_PAGES,
  sniffDocumentFormat,
  textOfWordprocessingXml,
  walkWordprocessingXml,
} from "./document-text.js";
import { MAX_PDF_PICTURES, pictureToken } from "./pdf-pictures.js";
import {
  docxHeading,
  docxParagraphs,
  makeDocx,
  makeNonWordZip,
  makeOleBytes,
  makePdf,
  type PdfBookmark,
  type PdfPictureFixture,
} from "./testing/document-fixtures.js";
import { readPng } from "./testing/read-png.js";

/** The zh page marker (the default), for the PDF expectations. */
const pg = (n: number): string => `── 第 ${n} 页 ──`;

describe("sniffDocumentFormat — extension AND magic (ADR 0038 §2)", () => {
  it(".pdf with the %PDF- header is pdf", () => {
    expect(sniffDocumentFormat("report.pdf", makePdf([["x"]]))).toEqual({
      kind: "pdf",
    });
    // Case-insensitive extension.
    expect(sniffDocumentFormat("REPORT.PDF", makePdf([["x"]]))).toEqual({
      kind: "pdf",
    });
  });

  it("tolerates leading junk before the header, as pdfjs does, within 1024 bytes", () => {
    const junk = Buffer.concat([Buffer.alloc(200, 0x20), makePdf([["x"]])]);
    expect(sniffDocumentFormat("a.pdf", junk)).toEqual({ kind: "pdf" });
    const tooFar = Buffer.concat([Buffer.alloc(2000, 0x20), makePdf([["x"]])]);
    expect(sniffDocumentFormat("a.pdf", tooFar)).toEqual({ kind: "none" });
  });

  it(".pdf without the header is not ours — falls to the text path", () => {
    expect(
      sniffDocumentFormat("notes.pdf", Buffer.from("just text\n", "utf8")),
    ).toEqual({ kind: "none" });
  });

  it(".docx with the zip signature is docx; with the OLE signature it is unsupported; otherwise none", () => {
    expect(sniffDocumentFormat("spec.docx", makeDocx(""))).toEqual({
      kind: "docx",
    });
    expect(sniffDocumentFormat("spec.docx", makeOleBytes())).toEqual({
      kind: "unsupported",
    });
    expect(sniffDocumentFormat("spec.docx", Buffer.from("plain"))).toEqual({
      kind: "none",
    });
  });

  it("legacy Office and sibling OOXML extensions are unsupported regardless of bytes", () => {
    for (const name of [
      "a.doc",
      "a.xls",
      "a.ppt",
      "a.xlsx",
      "a.pptx",
      "A.DOC",
    ]) {
      expect(sniffDocumentFormat(name, Buffer.from("anything"))).toEqual({
        kind: "unsupported",
      });
    }
  });

  it("everything else is none — the ordinary text path decides", () => {
    for (const name of ["a.md", "a.txt", "a.csv", "a", ".pdfx", "a.pdf.bak"]) {
      expect(sniffDocumentFormat(name, makePdf([["x"]]))).toEqual({
        kind: "none",
      });
    }
  });
});

describe("extractDocumentText — pdf", () => {
  it("loads pdfjs with neither a DOM nor the native canvas present — the packaged app's exact conditions", async () => {
    // pdfjs 6 evaluates `new DOMMatrix()` at module scope and would polyfill
    // it from @napi-rs/canvas; that package is excluded from the workspace
    // (root pnpm override) precisely so this test runs under the same
    // conditions as the installed app, where no node_modules exist. If either
    // stub in installRenderingGlobalStubs is removed, this is the test that
    // fails — not the first user to attach a PDF.
    expect(
      (globalThis as { navigator?: { userAgent?: string } }).navigator
        ?.userAgent ?? "",
    ).not.toMatch(/jsdom/i);
    let canvasResolvable = true;
    try {
      const { createRequire } = await import("node:module");
      createRequire(import.meta.url).resolve("@napi-rs/canvas");
    } catch {
      canvasResolvable = false;
    }
    expect(canvasResolvable).toBe(false);
    // …and the load is QUIET about it: pdfjs's module-scope `console.warn`
    // for the missing canvas is the designed state, not an error, and it
    // read as one in the launch log (owner 2026-09-03). This is the first
    // PDF load in this file, so the import happens inside the spy.
    const warned: string[] = [];
    const spy = vi
      .spyOn(console, "warn")
      .mockImplementation((...args: unknown[]) => {
        warned.push(String(args[0]));
      });
    try {
      const r = await extractDocumentText("pdf", makePdf([["still works"]]));
      expect(r).toEqual({ ok: true, text: `${pg(1)}\nstill works`, pages: 1 });
      // The filter is scoped to the import: what was console.warn before the
      // load (the spy) is console.warn again after it.
      expect(console.warn).toBe(spy);
    } finally {
      spy.mockRestore();
    }
    expect(warned.filter((w) => /napi-rs\/canvas|polyfill/.test(w))).toEqual(
      [],
    );
    // 30 s tier (2026-09-03): this is the file's FIRST pdfjs load — 3 MB of
    // engine through vitest's transform — and under full-suite contention
    // it took 7.4 s once today, against 0.36 s alone. The load is not slow;
    // the machine is busy (same class as the 2026-08-31 scanner guards).
  }, 30_000);

  it("extracts text with line breaks and a page count, every page opened by its marker line (2026-08-23)", async () => {
    const r = await extractDocumentText(
      "pdf",
      makePdf([["Hello (world)", "Second line"], ["Page two"]]),
    );
    expect(r).toEqual({
      ok: true,
      text: `${pg(1)}\nHello (world)\nSecond line\n\n${pg(2)}\nPage two`,
      pages: 2,
    });
    // The marker is localized by the session language and lives in core
    // (pageMarkerLine), so the three readers of the shape agree.
    const en = await extractDocumentText("pdf", makePdf([["x"], ["y"]]), {
      lang: "en",
    });
    expect(en.ok && en.text).toBe("── page 1 ──\nx\n\n── page 2 ──\ny");
  });

  it("returns to the event loop between pages — the parse is not one uninterrupted turn (perf audit 2026-09-20)", async () => {
    // pdfjs runs on its in-process fake worker, whose port dispatches through
    // `Promise.then` alone: every await in the page loop was a MICROtask, so a
    // long document held the loop — in the desktop app, the main thread — for
    // the whole parse. A macrotask that re-arms itself counts the turns the
    // loop got while the extraction ran.
    const PAGES = 12;
    let turns = 0;
    let running = true;
    const tick = (): void => {
      if (!running) return;
      turns += 1;
      setImmediate(tick);
    };
    const pdf = makePdf(
      Array.from({ length: PAGES }, (_, i) => [`page ${i + 1} text`]),
    );
    // Warm the lazy pdfjs import first, so the turns counted belong to the
    // page loop and not to loading the library.
    await extractDocumentText("pdf", makePdf([["warm"]]));
    setImmediate(tick);
    const r = await extractDocumentText("pdf", pdf);
    running = false;
    expect(r.ok && r.pages).toBe(PAGES);
    // One yield per page boundary. Without them the count is 0–2 (whatever
    // the document load itself lets through).
    expect(turns).toBeGreaterThanOrEqual(PAGES - 1);
  }, 30_000);

  it("a page with no text content is `empty` — the scanned-PDF case ADR 0033 §5 warned about; the markers alone do not make it a text file", async () => {
    const r = await extractDocumentText("pdf", makePdf([[], []]));
    expect(r).toEqual({ ok: false, reason: "empty", pages: 2 });
  });

  it("a PDF's bookmarks become the outline: page + that page's marker line, nested by depth, named and explicit dests alike", async () => {
    const r = await extractDocumentText(
      "pdf",
      makePdf([["one"], ["two", "more"], ["three"]], {
        bookmarks: [
          { title: "Chapter 1", page: 1 },
          {
            title: "Chapter 2",
            page: 2,
            named: true,
            items: [{ title: "  Section  2.1 ", page: 3 }],
          },
          { title: "No dest", page: 0 },
        ],
      }),
    );
    if (!r.ok) throw new Error(r.reason);
    // Page 1's marker is line 1; page 2 starts after "one" + blank = line 4;
    // page 3 after "two","more" + blank = line 8.
    expect(r.outline).toEqual([
      { level: 1, title: "Chapter 1", page: 1, line: 1 },
      { level: 1, title: "Chapter 2", page: 2, line: 4 },
      { level: 2, title: "Section 2.1", page: 3, line: 8 },
      { level: 1, title: "No dest", line: 1 },
    ]);
    const lines = r.text.split("\n");
    expect(lines[0]).toBe(pg(1));
    expect(lines[3]).toBe(pg(2));
    expect(lines[7]).toBe(pg(3));
  });

  it("a PDF without bookmarks carries no outline at all — absence is a fact, not an empty list", async () => {
    const r = await extractDocumentText("pdf", makePdf([["plain"]]));
    expect(r.ok && "outline" in r).toBe(false);
  });

  it("the outline is bounded in entries and depth", async () => {
    const deep = (d: number): PdfBookmark =>
      d > MAX_OUTLINE_DEPTH + 2
        ? { title: `d${d}`, page: 1 }
        : { title: `d${d}`, page: 1, items: [deep(d + 1)] };
    const many = Array.from({ length: MAX_OUTLINE_ENTRIES + 5 }, (_, i) => ({
      title: `e${i}`,
      page: 1,
    }));
    const r = await extractDocumentText(
      "pdf",
      makePdf([["p"]], { bookmarks: [deep(1), ...many] }),
    );
    if (!r.ok || r.outline === undefined) throw new Error("no outline");
    expect(Math.max(...r.outline.map((e) => e.level))).toBe(MAX_OUTLINE_DEPTH);
    expect(r.outline.length).toBe(MAX_OUTLINE_ENTRIES);
  });

  it("a password-protected file is `encrypted`, not a generic parse error", async () => {
    const r = await extractDocumentText(
      "pdf",
      makePdf([["secret"]], { encrypt: true }),
    );
    expect(r).toEqual({ ok: false, reason: "encrypted" });
  });

  it("garbage that passed the sniff is `parse_error`", async () => {
    const r = await extractDocumentText(
      "pdf",
      Buffer.from("%PDF-1.4\nthis is not a pdf body\n", "latin1"),
    );
    expect(r).toEqual({ ok: false, reason: "parse_error" });
  });

  it("over the page cap is refused whole with the page count (ADR 0038 §4)", async () => {
    const twelve = makePdf(Array.from({ length: 12 }, (_, i) => [`p${i + 1}`]));
    const r = await extractDocumentText("pdf", twelve, { maxPages: 10 });
    expect(r).toEqual({ ok: false, reason: "too_many_pages", pages: 12 });
    // At the cap exactly, it goes through.
    const ok = await extractDocumentText("pdf", twelve, { maxPages: 12 });
    expect(ok.ok).toBe(true);
    expect(MAX_PDF_PAGES).toBe(1000);
  });

  it("does not consume the caller's buffer (the ingest still hashes it)", async () => {
    const bytes = makePdf([["keep me"]]);
    const before = Buffer.from(bytes);
    await extractDocumentText("pdf", bytes);
    expect(bytes.equals(before)).toBe(true);
    expect(bytes.byteLength).toBe(before.byteLength);
  });

  it("Latin-1 text through WinAnsi decodes to the right characters", async () => {
    const r = await extractDocumentText("pdf", makePdf([["caf\xe9 na\xefve"]]));
    expect(r).toEqual({ ok: true, text: `${pg(1)}\ncafé naïve`, pages: 1 });
  });
});

describe("extractDocumentText — docx", () => {
  it("extracts paragraphs as lines and decodes entities", async () => {
    const r = await extractDocumentText(
      "docx",
      makeDocx(docxParagraphs(["Hello", "第二段 & <more>", 'quoted "x"'])),
    );
    expect(r).toEqual({
      ok: true,
      text: 'Hello\n第二段 & <more>\nquoted "x"',
    });
  });

  it("heading styles become the outline with the paragraph's line (2026-08-23): English ids, Chinese Word's bare numbers, Title, and an explicit outlineLvl", async () => {
    const body =
      docxHeading("Intro", { style: "Heading1" }) +
      docxParagraphs(["body one", "body two"]) +
      docxHeading("第二章", { style: "2" }) +
      docxHeading("Doc Title", { style: "Title" }) +
      // Body style with an explicit outline level wins over the style name.
      docxHeading("Forced", { style: "Normal", outlineLvl: 2 }) +
      // Not headings: TOC entries, a heading character style, body text.
      docxHeading("toc line", { style: "TOC1" }) +
      docxParagraphs(["plain"]);
    const r = await extractDocumentText("docx", makeDocx(body));
    if (!r.ok) throw new Error(r.reason);
    expect(r.text.split("\n")).toEqual([
      "Intro",
      "body one",
      "body two",
      "第二章",
      "Doc Title",
      "Forced",
      "toc line",
      "plain",
    ]);
    expect(r.outline).toEqual([
      { level: 1, title: "Intro", line: 1 },
      { level: 2, title: "第二章", line: 4 },
      { level: 1, title: "Doc Title", line: 5 },
      { level: 3, title: "Forced", line: 6 },
    ]);
  });

  it("a Word file without headings carries no outline; a break inside a paragraph still counts as a line", () => {
    const plain = walkWordprocessingXml(docxParagraphs(["a", "b"]));
    expect(plain.outline).toEqual([]);
    const xml =
      "<w:p><w:r><w:t>a</w:t><w:br/><w:t>b</w:t></w:r></w:p>" +
      docxHeading("H", { style: "Heading1" });
    expect(walkWordprocessingXml(xml).outline).toEqual([
      { level: 1, title: "H", line: 3 },
    ]);
  });

  it("an empty document is `empty`", async () => {
    expect(await extractDocumentText("docx", makeDocx(""))).toEqual({
      ok: false,
      reason: "empty",
    });
    expect(
      await extractDocumentText("docx", makeDocx(docxParagraphs(["  ", ""]))),
    ).toEqual({ ok: false, reason: "empty" });
  });

  it("a zip without word/document.xml is `unsupported` (an .xlsx renamed .docx)", async () => {
    expect(await extractDocumentText("docx", makeNonWordZip())).toEqual({
      ok: false,
      reason: "unsupported",
    });
  });

  it("a corrupt zip is `parse_error`", async () => {
    const broken = Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x03, 0x04]),
      Buffer.alloc(40, 0xff),
    ]);
    expect(await extractDocumentText("docx", broken)).toEqual({
      ok: false,
      reason: "parse_error",
    });
  });
});

describe("textOfWordprocessingXml — the walk", () => {
  it("emits tabs for w:tab and cell boundaries, newlines for w:br/w:cr, hyphen for w:noBreakHyphen", () => {
    const xml =
      "<w:p><w:r><w:t>a</w:t></w:r><w:r><w:tab/></w:r><w:r><w:t>b</w:t><w:br/><w:t>c</w:t></w:r></w:p>" +
      "<w:tbl><w:tr><w:tc><w:p><w:r><w:t>r1c1</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>r1c2</w:t></w:r></w:p></w:tc></w:tr></w:tbl>" +
      "<w:p><w:r><w:t>non</w:t><w:noBreakHyphen/><w:t>breaking</w:t></w:r></w:p>";
    expect(textOfWordprocessingXml(xml)).toBe(
      "a\tb\nc\nr1c1\n\tr1c2\n\tnon-breaking",
    );
  });

  it("does not confuse w:t with w:tab/w:tbl/w:tc, nor w:p with w:pPr/w:pStyle", () => {
    const xml =
      '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t xml:space="preserve">Title </w:t></w:r></w:p>' +
      "<w:tbl><w:tblPr/><w:tr><w:tc><w:tcPr/><w:p><w:r><w:t>cell</w:t></w:r></w:p></w:tc></w:tr></w:tbl>";
    expect(textOfWordprocessingXml(xml)).toBe("Title \ncell\n\t");
  });

  it("ignores field codes, tracked deletions and every non-w:t element", () => {
    const xml =
      "<w:p><w:r><w:instrText>PAGE</w:instrText></w:r><w:del><w:r><w:delText>gone</w:delText></w:r></w:del><w:r><w:t>kept</w:t></w:r></w:p>";
    expect(textOfWordprocessingXml(xml)).toBe("kept");
  });

  it("decodes numeric references and refuses out-of-range code points", () => {
    const xml =
      "<w:p><w:r><w:t>&#x4E2D;&#25991;&amp;lt;&#x110000;</w:t></w:r></w:p>";
    expect(textOfWordprocessingXml(xml)).toBe("中文&lt;");
  });

  it("a self-closing w:t emits nothing and does not swallow what follows", () => {
    const xml = "<w:p><w:r><w:t/></w:r><w:r><w:t>after</w:t></w:r></w:p>";
    expect(textOfWordprocessingXml(xml)).toBe("after");
  });
});

describe("extractDocumentText — pdf pictures (2026-09-30)", () => {
  // Lines 60pt apart: "Question 1." at y=720, "(a)" at 660, "(b)" at 600 —
  // room to draw a picture under (a), the way a handout draws its formula.
  const questionPage = ["Question 1.", "(a)", "(b)"];
  const underA: PdfPictureFixture = {
    at: [72, 610, 120, 40],
    width: 12,
    height: 10,
    kind: "rgb",
  };

  it("without `pictures`, a PDF that draws pictures extracts exactly as before", async () => {
    const plain = makePdf([questionPage], { lineGap: 60 });
    const drawn = makePdf([questionPage], {
      lineGap: 60,
      pictures: [[underA]],
    });
    const a = await extractDocumentText("pdf", plain);
    const b = await extractDocumentText("pdf", drawn);
    expect(b).toEqual(a);
    expect(b).not.toHaveProperty("pictures");
  });

  it("with `pictures`, each picture becomes a PNG and a token line after the last line above it", async () => {
    const r = await extractDocumentText(
      "pdf",
      makePdf([questionPage], { lineGap: 60, pictures: [[underA]] }),
      { pictures: true },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.text).toBe(`${pg(1)}\nQuestion 1.\n(a)\n${pictureToken(1)}\n(b)`);
    expect(r.pictures).toHaveLength(1);
    const picture = r.pictures?.[0];
    expect(picture).toMatchObject({ id: 1, page: 1, index: 1 });
    const png = readPng(picture?.png as Buffer);
    expect([png.width, png.height, png.colorType]).toEqual([12, 10, 2]);
    // The fixture's left half is red.
    expect([...(png.rows[0]?.subarray(0, 3) ?? [])]).toEqual([255, 0, 0]);
  });

  /** A distinct picture: identical pixels would be one picture drawn twice. */
  const shaded = (
    at: PdfPictureFixture["at"],
    shade: number,
  ): PdfPictureFixture => ({
    ...underA,
    at,
    data: new Uint8Array(12 * 10 * 3).fill(shade),
  });

  it("numbers pictures top to bottom per page, with ids running across the document", async () => {
    const r = await extractDocumentText(
      "pdf",
      makePdf([questionPage, ["Page two"]], {
        lineGap: 60,
        // Drawn bottom-first: the order in the file is not the reading order.
        pictures: [
          [shaded([72, 540, 120, 40], 1), shaded([72, 610, 120, 40], 2)],
          [shaded([72, 600, 120, 40], 3)],
        ],
      }),
      { pictures: true },
    );
    if (!r.ok) throw new Error(r.reason);
    expect(r.pictures?.map(({ id, page, index }) => [id, page, index])).toEqual(
      [
        [1, 1, 1],
        [2, 1, 2],
        [3, 2, 1],
      ],
    );
    expect(r.text).toBe(
      `${pg(1)}\nQuestion 1.\n(a)\n${pictureToken(1)}\n(b)\n${pictureToken(2)}\n\n${pg(2)}\nPage two\n${pictureToken(3)}`,
    );
  });

  it("a 1-bit picture decodes with a set bit as white; an RGBA picture keeps its alpha", async () => {
    const r = await extractDocumentText(
      "pdf",
      makePdf([questionPage], {
        lineGap: 60,
        pictures: [
          [
            { at: [72, 670, 160, 40], width: 16, height: 8, kind: "gray1" },
            { ...underA, kind: "rgba" },
          ],
        ],
      }),
      { pictures: true },
    );
    if (!r.ok) throw new Error(r.reason);
    const [gray, rgba] = (r.pictures ?? []).map((p) => readPng(p.png));
    expect(gray?.colorType).toBe(0);
    // Row 0 is 0xF0 0x0F: 4 white, 8 black, 4 white.
    expect([...(gray?.rows[0] ?? [])]).toEqual([
      255, 255, 255, 255, 0, 0, 0, 0, 0, 0, 0, 0, 255, 255, 255, 255,
    ]);
    expect(rgba?.colorType).toBe(6);
    // Right half: blue at alpha 128.
    expect([...(rgba?.rows[0]?.subarray(11 * 4, 12 * 4) ?? [])]).toEqual([
      0, 0, 255, 128,
    ]);
  });

  it("specks are not pictures: too few pixels, or drawn too small", async () => {
    const r = await extractDocumentText(
      "pdf",
      makePdf([questionPage], {
        lineGap: 60,
        pictures: [
          [
            { ...underA, width: 4, height: 4 },
            { ...underA, at: [72, 610, 2, 40] },
          ],
        ],
      }),
      { pictures: true },
    );
    if (!r.ok) throw new Error(r.reason);
    expect(r).not.toHaveProperty("pictures");
    expect(r.text).toBe(`${pg(1)}\nQuestion 1.\n(a)\n(b)`);
  });

  it("a scan — pictures and no text layer — stays empty (ADR 0038 §4)", async () => {
    const r = await extractDocumentText(
      "pdf",
      makePdf([[]], { pictures: [[underA]] }),
      { pictures: true },
    );
    expect(r).toEqual({ ok: false, reason: "empty", pages: 1 });
  });

  it(`keeps at most ${MAX_PDF_PICTURES} pictures a document`, async () => {
    const many: PdfPictureFixture[] = Array.from(
      { length: MAX_PDF_PICTURES + 5 },
      (_, i) => ({
        at: [72 + (i % 10) * 50, 100 + Math.floor(i / 10) * 60, 40, 40],
        width: 8,
        height: 8,
        kind: "rgb",
        // Distinct pixels per picture, so none is a duplicate of another.
        data: new Uint8Array(8 * 8 * 3).fill(i),
      }),
    );
    const r = await extractDocumentText(
      "pdf",
      makePdf([questionPage], { lineGap: 60, pictures: [many] }),
      { pictures: true },
    );
    if (!r.ok) throw new Error(r.reason);
    expect(r.pictures).toHaveLength(MAX_PDF_PICTURES);
  });
});

describe("extractDocumentText — pictures that are not content (review on #6)", () => {
  const questionPage = ["Question 1.", "(a)", "(b)"];
  /** Covers the whole 612×792 page, like a scan's page image or a slide's
   *  full-bleed background. */
  const fullPage: PdfPictureFixture = {
    at: [0, 0, 612, 792],
    width: 16,
    height: 20,
    kind: "rgb",
  };
  const formula = (shade: number): PdfPictureFixture => ({
    at: [72, 610, 120, 40],
    width: 12,
    height: 10,
    kind: "rgb",
    data: new Uint8Array(12 * 10 * 3).fill(shade),
  });

  it("a picture covering most of a page that has text is skipped — a scan under its OCR layer, a slide background", async () => {
    const r = await extractDocumentText(
      "pdf",
      makePdf([questionPage], {
        lineGap: 60,
        pictures: [[fullPage, formula(1)]],
      }),
      { pictures: true },
    );
    if (!r.ok) throw new Error(r.reason);
    // Only the formula: the page image is left to the text it carries.
    expect(r.pictures).toHaveLength(1);
    expect(r.text).toBe(
      `── 第 1 页 ──\nQuestion 1.\n(a)\n${pictureToken(1)}\n(b)`,
    );
  });

  it("…but on a page WITHOUT text the same picture is the content, and is kept", async () => {
    const r = await extractDocumentText(
      "pdf",
      makePdf([questionPage, []], {
        lineGap: 60,
        pictures: [[], [fullPage]],
      }),
      { pictures: true },
    );
    if (!r.ok) throw new Error(r.reason);
    expect(r.pictures?.map(({ page }) => page)).toEqual([2]);
    expect(r.text.endsWith(`── 第 2 页 ──\n${pictureToken(1)}`)).toBe(true);
  });

  it("a picture drawn again — a letterhead on every page — keeps its first line only and counts once toward the cap", async () => {
    const logo: PdfPictureFixture = {
      at: [400, 730, 60, 30],
      width: 12,
      height: 8,
      kind: "rgb",
      data: new Uint8Array(12 * 8 * 3).fill(77),
    };
    const pages = Array.from({ length: 5 }, () => questionPage);
    const r = await extractDocumentText(
      "pdf",
      makePdf(pages, {
        lineGap: 60,
        pictures: pages.map((_, i) => [logo, formula(10 + i)]),
      }),
      { pictures: true },
    );
    if (!r.ok) throw new Error(r.reason);
    // One logo and five formulas: six distinct pictures, six lines.
    expect(r.pictures).toHaveLength(6);
    expect(r.pictures?.[0]).toMatchObject({ page: 1, index: 1 });
    expect(r.text.match(/\u27E6picture:\d+\u27E7/g)).toHaveLength(6);
  });
});
