import { extname } from "node:path";
import { type PageMarkerLang, pageMarkerLine } from "@herta/core";
import { strFromU8, unzipSync } from "fflate";
import {
  type BaselinedLine,
  collectPagePictures,
  type PdfPicture,
  pictureScanOpen,
  slotPictures,
  startPictureScan,
} from "./pdf-pictures.js";

/**
 * Text extraction for the two document formats people actually hand over
 * (ADR 0038): PDF and Word `.docx`. Both fell through `looksBinary` before
 * this — stored, cited, and unreadable by every tool that would be pointed at
 * them. The ingest calls `sniffDocumentFormat` first and, for a recognized
 * format, stores the EXTRACTED TEXT as the attachment (ADR 0038 §1); nothing
 * downstream learns a new file type.
 *
 * Boundaries this module keeps on purpose:
 * - It never touches the record. It returns text or a reason; `attachments.ts`
 *   turns either into a block that says what happened (ADR 0033 §5).
 * - pdfjs is loaded lazily and only here (§3): the GUI main bundle keeps it as
 *   its own chunk, and app startup never parses 3 MB of PDF engine.
 * - The docx walk is our own ~80 lines over fflate rather than a Word library:
 *   byte-equal to mammoth on real files, without its ten transitive packages.
 */

export type DocumentFormat = "pdf" | "docx";

/** Where the ingest should send a file, decided by extension AND magic bytes.
 *  `none` means "not ours — take the ordinary text path"; `unsupported` means
 *  a document format we recognize and cannot decode, which deserves a better
 *  answer than `非文本文件`. */
export type DocumentSniff =
  | { readonly kind: DocumentFormat }
  | { readonly kind: "unsupported" }
  | { readonly kind: "none" };

/**
 * One entry of a document's own outline (2026-08-23): a PDF bookmark or a
 * Word heading. `line` is where it starts in the EXTRACTED text — for a PDF
 * that is the page marker's line (the bookmark points at a page, not a line),
 * for Word the heading paragraph's own line — so 板砖 can `sed -n` straight to
 * it. Deterministic: read from the file's structure, never inferred from its
 * prose, so an absent outline is a fact about the document.
 */
export interface OutlineEntry {
  /** 1-based nesting depth. */
  readonly level: number;
  readonly title: string;
  /** PDF only; 1-based. */
  readonly page?: number;
  /** 1-based line in the extracted text. */
  readonly line: number;
}

export type ExtractedDocument =
  | {
      readonly ok: true;
      readonly text: string;
      /** PDF only. */
      readonly pages?: number;
      /** Present only when the document carries one (see OutlineEntry). */
      readonly outline?: readonly OutlineEntry[];
      /** PDF only, when `pictures` was asked for and the document draws any:
       *  the pictures, each standing in `text` as its `pictureToken` line. */
      readonly pictures?: readonly PdfPicture[];
    }
  | {
      readonly ok: false;
      readonly reason:
        | "empty"
        | "encrypted"
        | "too_many_pages"
        | "unsupported"
        | "parse_error";
      /** PDF only, when the document opened far enough to count. */
      readonly pages?: number;
    };

/**
 * Page ceiling for PDF extraction (ADR 0038 §4). Refused WHOLE above it, on
 * ADR 0033's own no-silent-prefix rule; the number is a main-process time
 * bound (≈10–15 s at the measured ~10–20 ms/page), and a book-length PDF is
 * the edge, not the use.
 */
export const MAX_PDF_PAGES = 1000;

/** Outline ceiling, entries and depth. A textbook's bookmarks run to a few
 *  hundred; past this the sidecar stops being a map and becomes a second
 *  document. Depth 4 keeps chapter/section/subsection/item; deeper bookmark
 *  trees are index-grade detail 板砖 finds faster by grep. */
export const MAX_OUTLINE_ENTRIES = 400;
export const MAX_OUTLINE_DEPTH = 4;
const MAX_OUTLINE_TITLE_CHARS = 120;

/** Legacy binary Office and the sibling OOXML formats this slice does not
 *  decode. Listed by extension so a `.doc` gets `暂不支持` rather than
 *  `非文本文件` — the second is true and useless. */
const UNSUPPORTED_DOCUMENT_EXTS: ReadonlySet<string> = new Set([
  ".doc",
  ".xls",
  ".ppt",
  ".xlsx",
  ".pptx",
]);

const PDF_MAGIC = "%PDF-";
/** The PDF spec allows the header anywhere in the first 1024 bytes; pdfjs
 *  tolerates leading junk up to that, so the sniff matches it. */
const PDF_MAGIC_WINDOW = 1024;
const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04] as const;
/** OLE compound file — a legacy `.doc`, or an encrypted OOXML package (which
 *  is stored as an OLE container). Either way not a zip we can read. */
const OLE_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1] as const;

function startsWith(bytes: Uint8Array, magic: readonly number[]): boolean {
  if (bytes.length < magic.length) return false;
  for (let i = 0; i < magic.length; i += 1) {
    if (bytes[i] !== magic[i]) return false;
  }
  return true;
}

function hasPdfHeader(bytes: Uint8Array): boolean {
  const window = bytes.subarray(0, Math.min(bytes.length, PDF_MAGIC_WINDOW));
  // latin1 so every byte maps to one char and indexOf is a byte search.
  return strFromU8(window, true).includes(PDF_MAGIC);
}

/**
 * Extension AND magic (ADR 0038 §2). Extension alone would send a renamed
 * binary into a parser; magic alone would treat every zip as Word. A `.pdf`
 * without the header, or a `.docx` that is neither zip nor OLE, falls to
 * `none` — the text path then does what it always did with those bytes.
 */
export function sniffDocumentFormat(
  displayName: string,
  bytes: Uint8Array,
): DocumentSniff {
  const ext = extname(displayName).toLowerCase();
  if (ext === ".pdf") {
    return hasPdfHeader(bytes) ? { kind: "pdf" } : { kind: "none" };
  }
  if (ext === ".docx") {
    if (startsWith(bytes, ZIP_MAGIC)) return { kind: "docx" };
    if (startsWith(bytes, OLE_MAGIC)) return { kind: "unsupported" };
    return { kind: "none" };
  }
  if (UNSUPPORTED_DOCUMENT_EXTS.has(ext)) return { kind: "unsupported" };
  return { kind: "none" };
}

export interface ExtractOptions {
  readonly maxPages?: number;
  /** Language of the page-marker lines a PDF's text is opened with (the
   *  session's interaction language, ADR 0016). Default zh. */
  readonly lang?: PageMarkerLang;
  /** PDF only: also collect the pictures the pages draw (see
   *  `pdf-pictures.ts`) and mark each one's place in the text. Off by default
   *  — a caller that asks must also put something where each token stands. */
  readonly pictures?: boolean;
}

export async function extractDocumentText(
  format: DocumentFormat,
  bytes: Uint8Array,
  opts: ExtractOptions = {},
): Promise<ExtractedDocument> {
  return format === "pdf"
    ? extractPdfText(bytes, opts)
    : extractDocxText(bytes);
}

// ───── PDF ─────

type PdfJs = typeof import("pdfjs-dist/legacy/build/pdf.mjs");

let pdfjsPromise: Promise<PdfJs> | undefined;

/**
 * Lazy, once. The worker handler is imported STATICALLY (a literal specifier
 * rollup can bundle) and registered on `globalThis.pdfjsWorker`, which pdfjs's
 * Node "fake worker" consults before it would `import()` a variable
 * `workerSrc` — the path a bundler cannot follow (ADR 0038 §3). Registering it
 * ourselves rather than relying on the worker module's own top-level side
 * effect keeps this deterministic under any tree-shaking setting.
 */
async function loadPdfJs(): Promise<PdfJs> {
  if (pdfjsPromise === undefined) {
    pdfjsPromise = (async () => {
      installRenderingGlobalStubs();
      const [worker, lib] = await withoutCanvasWarning(() =>
        Promise.all([
          import("pdfjs-dist/legacy/build/pdf.worker.mjs"),
          import("pdfjs-dist/legacy/build/pdf.mjs"),
        ]),
      );
      (
        globalThis as { pdfjsWorker?: { WorkerMessageHandler: unknown } }
      ).pdfjsWorker = { WorkerMessageHandler: worker.WorkerMessageHandler };
      return lib;
    })();
    // A failed load must not be cached as the answer for the rest of the
    // process — the next attach retries the import.
    pdfjsPromise.catch(() => {
      pdfjsPromise = undefined;
    });
  }
  return pdfjsPromise;
}

/**
 * pdfjs 6's display build evaluates `new DOMMatrix()` at MODULE SCOPE (a
 * rendering constant), so importing it under Node throws `ReferenceError`
 * unless something has defined the global; and it warns at import when
 * `Path2D` is missing. pdfjs would polyfill both from its optional native
 * `@napi-rs/canvas` — which is exactly the dependency ADR 0038 §3 excludes,
 * because the packaged app ships no node_modules and could never have loaded
 * it: with canvas present in dev only, PDF attach would have worked on every
 * developer machine and thrown in every installed copy.
 *
 * Text extraction never touches a matrix or a path; `getTextContent` runs in
 * the worker half. So the stubs are deliberately inert: they exist to let the
 * module evaluate. If a rendering path is ever added here, this is the first
 * thing to replace — a method call on either will throw, be caught, and
 * surface as `parse_error`, not as wrong output. Installed only when absent,
 * so a real DOM (a jsdom test, a renderer) is never shadowed.
 */
/**
 * pdfjs also `require`s `@napi-rs/canvas` at MODULE SCOPE under Node and
 * `console.warn`s when it is absent — synchronously, during evaluation, so
 * `setVerbosityLevel` (which lives inside the module) cannot run first. The
 * absence is the packaged app's designed state (§3 above), so the line is
 * noise that reads as an error in the launch log (owner 2026-09-03, a second
 * machine). For the span of the import only, that one known line is dropped;
 * every other warning still reaches the console, and the original `warn` is
 * restored whether the import resolves or throws.
 */
const CANVAS_WARNING =
  /Cannot (load "@napi-rs\/canvas" package|polyfill `(DOMMatrix|Path2D)`)/;

async function withoutCanvasWarning<T>(load: () => Promise<T>): Promise<T> {
  const original = console.warn;
  console.warn = (...args: unknown[]): void => {
    if (typeof args[0] === "string" && CANVAS_WARNING.test(args[0])) return;
    original.apply(console, args);
  };
  try {
    return await load();
  } finally {
    console.warn = original;
  }
}

function installRenderingGlobalStubs(): void {
  const g = globalThis as { DOMMatrix?: unknown; Path2D?: unknown };
  // A bare class: JS constructors accept (and ignore) any arguments, so the
  // init value every pdfjs call site passes is simply dropped.
  if (g.DOMMatrix === undefined) g.DOMMatrix = class DOMMatrixStub {};
  if (g.Path2D === undefined) g.Path2D = class Path2DStub {};
}

async function extractPdfText(
  bytes: Uint8Array,
  opts: ExtractOptions,
): Promise<ExtractedDocument> {
  const maxPages = opts.maxPages ?? MAX_PDF_PAGES;
  const lang = opts.lang ?? "zh";
  // The engine load sits INSIDE the try: the ingest's contract is never to
  // throw (a throw is a file that vanished without a trace), so a failed
  // import must come back as a stated failure like any other.
  let task: ReturnType<PdfJs["getDocument"]> | undefined;
  try {
    const pdfjs = await loadPdfJs();
    // Own copy: pdfjs may transfer/detach the buffer it is handed, and the
    // caller still needs the original bytes for the content hash.
    const data = new Uint8Array(bytes);
    task = pdfjs.getDocument({
      data,
      // Text only. No font faces and no system font lookup — what a renderer
      // wants and an extractor does not.
      useSystemFonts: false,
      disableFontFace: true,
      verbosity: 0,
    });
    const doc = await task.promise;
    const pages = doc.numPages;
    if (pages > maxPages) return { ok: false, reason: "too_many_pages", pages };
    // Every page opens with its marker line (2026-08-23); pages are separated
    // by a blank line as before, so paragraph spacing reads the same and the
    // marker sits in its own visual gap. `pageLine[p]` is the marker's
    // 1-based line — the bookmark outline below cites it.
    const out: string[] = [];
    const pageLine: number[] = [];
    let nextLine = 1;
    let body = 0;
    const pictures: PdfPicture[] = [];
    const scan = opts.pictures === true ? startPictureScan() : undefined;
    for (let p = 1; p <= pages; p += 1) {
      // Back to the event loop between pages. pdfjs runs here on its
      // in-process "fake worker", whose message port dispatches through
      // `Promise.then` alone (LoopbackPort, pdfjs 6.2) — so every `await`
      // below yields a MICROtask and the whole document parsed as one
      // uninterrupted turn of the loop. In the desktop app that loop is the
      // main thread: a few hundred pages froze the window, its drag region
      // and every IPC for the length of the parse (perf audit 2026-09-20).
      if (p > 1) await new Promise<void>((next) => setImmediate(next));
      const page = await doc.getPage(p);
      try {
        const content = await page.getTextContent();
        const lines = textLinesOf(content.items);
        let pageText = lines.map((l) => l.text).join("\n");
        body += pageText.trim().length;
        // Pictures are searched for only once the document has shown text:
        // a scan (pictures and no text layer at all) stays `empty` below, and
        // decoding its page images first would only delay that answer.
        if (scan !== undefined && body > 0 && pictureScanOpen(scan, p)) {
          const found = await collectPagePictures(page, pdfjs, scan, {
            pageHasText: pageText.trim().length > 0,
          });
          if (found.length > 0) {
            const numbered = found.map((picture, k) => ({
              id: pictures.length + k + 1,
              page: p,
              index: k + 1,
              png: picture.png,
              bottom: picture.bottom,
            }));
            for (const { id, page: onPage, index, png } of numbered) {
              pictures.push({ id, page: onPage, index, png });
            }
            pageText = slotPictures(lines, numbered).join("\n");
          }
        }
        pageLine[p] = nextLine;
        const chunk = `${pageMarkerLine(p, lang)}\n${pageText}`;
        out.push(chunk);
        // The chunk's own lines plus the blank separator before the next.
        nextLine += chunk.split("\n").length + 1;
      } finally {
        page.cleanup();
      }
    }
    // "Empty" is judged on the document's OWN text: a scan carries no text
    // and the markers alone must not turn it into a stored file of headings
    // over nothing (ADR 0038 §4's scanned-PDF rule). Pictures do not lift it
    // (2026-09-30): reading whole scanned pages is OCR, a feature of its own.
    if (body === 0) return { ok: false, reason: "empty", pages };
    const text = out.join("\n\n");
    const outline = await pdfOutline(doc, pageLine);
    return {
      ok: true,
      text,
      pages,
      ...(outline.length > 0 ? { outline } : {}),
      ...(pictures.length > 0 ? { pictures } : {}),
    };
  } catch (err) {
    // pdfjs raises a distinct exception for a password-protected file; the
    // rest (InvalidPDF, malformed xref, truncated stream) is "could not parse".
    if (isNamedError(err, "PasswordException")) {
      return { ok: false, reason: "encrypted" };
    }
    return { ok: false, reason: "parse_error" };
  } finally {
    // Frees the fake worker's document state; without it each attach leaks
    // the parsed object graph for the process lifetime.
    if (task !== undefined) await task.destroy().catch(() => undefined);
  }
}

type PdfDocument = Awaited<ReturnType<PdfJs["getDocument"]>["promise"]>;

/**
 * The PDF's own bookmark tree, flattened to OutlineEntry[] with each node
 * resolved to the page it points at and that page's marker line.
 *
 * Resolution follows the spec's two dest shapes: a NAMED destination (string
 * → `getDestination`) or an explicit array whose first element is a page
 * reference (→ `getPageIndex`) or, in some producers' files, a bare page
 * index. A node whose dest cannot be resolved keeps its title with no page —
 * the heading still exists, and a reader can grep it — and any pdfjs error
 * in the walk yields the entries gathered so far rather than failing the
 * extraction: the text is the attachment, the outline is a convenience.
 */
async function pdfOutline(
  doc: PdfDocument,
  pageLine: readonly number[],
): Promise<OutlineEntry[]> {
  const entries: OutlineEntry[] = [];
  try {
    const tree = await doc.getOutline();
    if (tree === null || tree === undefined) return entries;
    type Node = { title?: unknown; dest?: unknown; items?: unknown };
    const visit = async (nodes: unknown, level: number): Promise<void> => {
      if (!Array.isArray(nodes) || level > MAX_OUTLINE_DEPTH) return;
      for (const raw of nodes) {
        if (entries.length >= MAX_OUTLINE_ENTRIES) return;
        const node = raw as Node;
        const title = cleanOutlineTitle(node.title);
        if (title.length === 0) continue;
        const page = await pageOfDest(doc, node.dest);
        const line = page !== undefined ? pageLine[page] : undefined;
        entries.push({
          level,
          title,
          ...(page !== undefined ? { page } : {}),
          // A bookmark without a resolvable page still names a heading; cite
          // the document's first line so the entry stays well-formed.
          line: line ?? 1,
        });
        await visit(node.items, level + 1);
      }
    };
    await visit(tree, 1);
  } catch {
    // Outline is best-effort by contract (see above).
  }
  return entries;
}

async function pageOfDest(
  doc: PdfDocument,
  dest: unknown,
): Promise<number | undefined> {
  try {
    const explicit =
      typeof dest === "string" ? await doc.getDestination(dest) : dest;
    if (!Array.isArray(explicit) || explicit.length === 0) return undefined;
    const first: unknown = explicit[0];
    if (typeof first === "number" && Number.isInteger(first) && first >= 0) {
      return first + 1;
    }
    if (typeof first === "object" && first !== null) {
      const index = await doc.getPageIndex(
        first as { num: number; gen: number },
      );
      return Number.isInteger(index) && index >= 0 ? index + 1 : undefined;
    }
  } catch {
    // Unresolvable dest — see pdfOutline.
  }
  return undefined;
}

function cleanOutlineTitle(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw.replace(/\s+/g, " ").trim().slice(0, MAX_OUTLINE_TITLE_CHARS);
}

/** pdfjs hands back a flat item list per page; `hasEOL` marks where the
 *  layout engine saw a line end, and it emits explicit whitespace items for
 *  gaps, so joining `str`s and breaking on `hasEOL` reproduces reading order
 *  well enough for a text file. Each line also keeps the baseline of its first
 *  visible item (the y of the item's transform) — what places a picture
 *  between lines (`slotPictures`); a whitespace-only line has none. */
function textLinesOf(items: ReadonlyArray<unknown>): BaselinedLine[] {
  const lines: BaselinedLine[] = [];
  let line = "";
  let baseline: number | undefined;
  for (const item of items) {
    // The list mixes TextItem with marked-content markers (no `str`).
    if (typeof item !== "object" || item === null || !("str" in item)) continue;
    const { str, hasEOL, transform } = item as {
      str: unknown;
      hasEOL?: unknown;
      transform?: unknown;
    };
    if (typeof str !== "string") continue;
    if (
      baseline === undefined &&
      str.trim() !== "" &&
      Array.isArray(transform)
    ) {
      const y: unknown = transform[5];
      if (typeof y === "number") baseline = y;
    }
    line += str;
    if (hasEOL === true) {
      lines.push({ text: line, baseline });
      line = "";
      baseline = undefined;
    }
  }
  if (line.length > 0) lines.push({ text: line, baseline });
  return lines;
}

function isNamedError(err: unknown, name: string): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "name" in err &&
    (err as { name?: unknown }).name === name
  );
}

// ───── DOCX ─────

const DOCX_MAIN_PART = "word/document.xml";

/**
 * A `.docx` is a zip; the body text lives in `word/document.xml` as `w:t`
 * runs inside `w:p` paragraphs. Only that one entry is inflated — images,
 * fonts and the rest of the package are skipped by fflate's filter without
 * decompression. The walk emits: a newline per paragraph, a tab per `w:tab`
 * and per table-cell boundary, a newline per explicit break. Field codes
 * (`w:instrText`), tracked deletions (`w:delText`) and every other element
 * are ignored — a reader wants the visible text, nothing else.
 */
function extractDocxText(bytes: Uint8Array): ExtractedDocument {
  let xml: string;
  try {
    const parts = unzipSync(bytes, {
      filter: (file) => file.name === DOCX_MAIN_PART,
    });
    const main = parts[DOCX_MAIN_PART];
    // A zip without the Word main part is some other OOXML (or any zip) that
    // happens to be named .docx.
    if (main === undefined) return { ok: false, reason: "unsupported" };
    xml = strFromU8(main);
  } catch {
    return { ok: false, reason: "parse_error" };
  }
  const { text, outline } = walkWordprocessingXml(xml);
  if (text.trim().length === 0) return { ok: false, reason: "empty" };
  return { ok: true, text, ...(outline.length > 0 ? { outline } : {}) };
}

/** Structural tags the walk reacts to. `w:t` opens/closes a text run; the
 *  others are pure emitters. Matched by name followed by whitespace, `/` or
 *  `>` so `w:tab` cannot match `w:table`… (nor `w:t` match `w:tab`).
 *  `w:pStyle` / `w:outlineLvl` (2026-08-23) are the paragraph's heading
 *  evidence, read for the outline and emitting nothing. */
const WORD_TAG =
  /<(\/?)(w:t|w:tab|w:br|w:cr|w:p|w:tc|w:noBreakHyphen|w:pStyle|w:outlineLvl)(?=[\s/>])([^>]*)>/g;

const W_VAL = /\bw:val="([^"]*)"/;

/**
 * Heading level from a paragraph's style id, or undefined for body text.
 * Word (English) names them `Heading1`…`Heading9`; Chinese Word's built-in
 * 标题 N styles carry the bare id `1`…`9`; LibreOffice and Google Docs export
 * the English ids. Anchored, so `TOC1` / `Heading1Char` never match. An
 * explicit `w:outlineLvl` on the paragraph (0-based) wins over the style name
 * when both are present — it is what Word's own navigation pane reads.
 */
function headingLevelOf(
  style: string | undefined,
  outlineLvl: number | undefined,
): number | undefined {
  if (outlineLvl !== undefined && outlineLvl >= 0 && outlineLvl < 9) {
    return outlineLvl + 1;
  }
  if (style === undefined) return undefined;
  const m = /^(?:heading|h)?\s*([1-9])$/i.exec(style.trim());
  if (m !== null) return Number(m[1]);
  if (/^title$/i.test(style.trim())) return 1;
  return undefined;
}

export function textOfWordprocessingXml(xml: string): string {
  return walkWordprocessingXml(xml).text;
}

export function walkWordprocessingXml(xml: string): {
  text: string;
  outline: OutlineEntry[];
} {
  const paragraphs: string[] = [];
  const outline: OutlineEntry[] = [];
  let para = "";
  let inText = false;
  let textStart = 0;
  // Heading evidence for the paragraph being walked, and the 1-based line
  // the NEXT paragraph will start at (paragraphs join with "\n"; a paragraph
  // spans one line plus one per explicit break inside it).
  let paraStyle: string | undefined;
  let paraOutlineLvl: number | undefined;
  let nextLine = 1;
  WORD_TAG.lastIndex = 0;
  let m: RegExpExecArray | null = WORD_TAG.exec(xml);
  while (m !== null) {
    const closing = m[1] === "/";
    const tag = m[2];
    const selfClosing = (m[3] ?? "").trimEnd().endsWith("/");
    if (tag === "w:pStyle" || tag === "w:outlineLvl") {
      if (!closing) {
        const val = W_VAL.exec(m[3] ?? "")?.[1];
        if (tag === "w:pStyle") paraStyle = val;
        else if (val !== undefined && /^\d+$/.test(val)) {
          paraOutlineLvl = Number(val);
        }
      }
    } else if (tag === "w:t") {
      if (closing) {
        if (inText) {
          para += decodeXmlEntities(xml.slice(textStart, m.index));
          inText = false;
        }
      } else if (!selfClosing) {
        inText = true;
        textStart = m.index + m[0].length;
      }
    } else if (!closing) {
      // Emitters — a closing form is not meaningful for these, and w:tab /
      // w:br / w:cr are self-closing in practice.
      if (tag === "w:tab") para += "\t";
      else if (tag === "w:br" || tag === "w:cr") para += "\n";
      else if (tag === "w:noBreakHyphen") para += "-";
    } else if (tag === "w:p") {
      const level = headingLevelOf(paraStyle, paraOutlineLvl);
      const title = cleanOutlineTitle(para.split("\n")[0]);
      if (
        level !== undefined &&
        title.length > 0 &&
        outline.length < MAX_OUTLINE_ENTRIES
      ) {
        outline.push({ level, title, line: nextLine });
      }
      paragraphs.push(para);
      nextLine += 1 + (para.match(/\n/g)?.length ?? 0);
      para = "";
      paraStyle = undefined;
      paraOutlineLvl = undefined;
    } else if (tag === "w:tc") {
      para += "\t";
    }
    m = WORD_TAG.exec(xml);
  }
  if (para.length > 0) paragraphs.push(para);
  return { text: paragraphs.join("\n"), outline };
}

/** The five XML entities plus numeric references — all that `w:t` content
 *  can legally carry. `&amp;` last, so `&amp;lt;` decodes to `&lt;` and not
 *  to `<`. An out-of-range code point (a corrupt file) becomes nothing rather
 *  than a throw out of the middle of a walk. */
function decodeXmlEntities(s: string): string {
  const cp = (n: number): string =>
    Number.isInteger(n) && n >= 0 && n <= 0x10ffff
      ? String.fromCodePoint(n)
      : "";
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) =>
      cp(Number.parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_, dec: string) => cp(Number(dec)))
    .replace(/&amp;/g, "&");
}
