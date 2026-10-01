import { promisify } from "node:util";
import { crc32, deflate } from "node:zlib";

/**
 * The pictures inside a PDF (2026-09-30).
 *
 * `getTextContent` returns the text layer and nothing else, and a document made
 * in Word — or pasted together from rendered web pages — routinely carries its
 * formulas, matrices and tables as pictures. What reached the record was the
 * question text with a hole where each picture sat (`(a)` followed by the next
 * `(b)`), so neither Herta nor 板砖 could read a single number of it; and
 * `view_image` opens image files, not a picture inside a PDF.
 *
 * This module finds the pictures a page draws through its operator list, takes
 * their pixels from pdfjs's object store (the worker has already decoded them),
 * re-encodes each as a PNG, and says where each one sits so the text can mark
 * the spot. Storing and transcribing them is `attachments.ts`'s job — nothing
 * here touches the workspace or the network.
 *
 * No canvas: the pixels come from pdfjs and the PNG is written with node:zlib,
 * so the packaged app (no native modules, ADR 0038 §3) runs it as it is. All
 * of it runs on the desktop app's MAIN process, where a long synchronous stretch
 * freezes the window, not just the attach — so the compression goes to the
 * thread pool and every pixel loop yields (`yielder`).
 */

type PdfJs = typeof import("pdfjs-dist/legacy/build/pdf.mjs");

const deflateAsync = promisify(deflate);

/** Distinct pictures kept per document. A lecture handout carries a few
 *  dozen; past this a document is a picture book, and a transcript per
 *  picture stops being a reading aid. A picture drawn again does not count —
 *  see `collectPagePictures`. */
export const MAX_PDF_PICTURES = 60;

/** Pages searched for pictures. Every searched page costs a second pass (the
 *  operator list, which also decodes the page's images) on the main process,
 *  and a book-length PDF is searched for its text, not read picture by
 *  picture. */
export const MAX_PICTURE_SCAN_PAGES = 200;

/** Wall-clock ceiling for the whole search, beside the page cap: one page with
 *  a huge image can cost more than a hundred plain ones. */
export const PICTURE_SCAN_BUDGET_MS = 20_000;

/**
 * A picture whose drawn box covers this share of its page or more, on a page
 * that has text of its own, is not collected: it is a scan's page image under
 * its OCR text layer, or a slide's full-bleed background, and either way the
 * text already IS the page. Without this rule a 30-page OCR'd scan decoded,
 * stored and queued for transcription 30 page images whose words had already
 * been extracted (review on #6: 18.5 s, 12.9 MB, 30 vision calls). On a page
 * WITHOUT text the same picture is the content — a full-page figure — and is
 * kept.
 */
export const FULL_PAGE_SHARE = 0.85;

/**
 * Images larger than this, in pixels, are never decoded for the picture search
 * (2026-10-01): pdfjs is opened with it as `maxImageSize`, and its evaluator
 * drops such an image from the operator list BEFORE decoding it. The full-page
 * rule above runs only once pdfjs has decoded the image — and pdfjs decodes on
 * the main process, inside `getOperatorList`: a 30-page OCR'd scan at 300 dpi
 * still spent ~11 s there, in ~0.4 s freezes per page, to collect nothing
 * (96 % of it pdfjs's JPEG decoder, profiled). A page scanned at 300 dpi is
 * 8.4–8.7 megapixels; a formula, a table or a diagram in a handout is a small
 * fraction of this. The trade-off is owned: a genuine picture above it is not
 * kept (the owner's pick over a background thread, 2026-10-01). Text
 * extraction never decodes images, so it is unaffected.
 */
export const MAX_PICTURE_DECODE_PIXELS = 4_000_000;

/** Smaller than this in pixels on either side: a rule, a bullet, a spacer. */
const MIN_PICTURE_SIDE_PX = 8;

/** Drawn smaller than this in points on either side: the same, judged by its
 *  size on the page rather than in the file. */
const MIN_PICTURE_DRAWN_PT = 4;

/** Longest side kept. Larger pictures are box-downscaled by an integer factor:
 *  a page scanned at 300 dpi is ~2500×3300 — more than a transcription or a
 *  look needs, and ~30 MB of raw pixels held on the main process. */
const MAX_PICTURE_SIDE_PX = 2000;

/** How long to wait for pdfjs to hand over one decoded image. */
const OBJECT_WAIT_MS = 5000;

/** How long a pixel loop may hold the main process before it yields. */
const SLICE_MS = 8;

/** One picture a page draws: its PNG and where it sits, in PDF user space
 *  (y grows upward — `top` is the larger y). */
export interface PagePicture {
  readonly png: Buffer;
  readonly top: number;
  readonly bottom: number;
  readonly left: number;
}

/**
 * A picture numbered for its document. `id` is document-wide and is what the
 * extracted text's token carries; `page` and `index` are what a reader is
 * shown (`图 3-2`: page 3, second picture from the top).
 */
export interface PdfPicture {
  readonly id: number;
  readonly page: number;
  readonly index: number;
  readonly png: Buffer;
}

/** Where a picture was drawn: its page and its box in user space. */
interface DrawnBox {
  readonly page: number;
  readonly left: number;
  readonly bottom: number;
  readonly width: number;
  readonly height: number;
}

/** A picture already collected: its PNG (a repeat reuses it — one file, one
 *  transcript) and every place it was drawn. */
interface SeenPicture {
  readonly png: Buffer;
  readonly boxes: DrawnBox[];
}

/** What one document's search spends from and remembers: the distinct
 *  pictures still allowed, the deadline, and the pixels already collected. */
export interface PictureScan {
  remaining: number;
  readonly deadline: number;
  readonly seen: Map<string, SeenPicture>;
}

export function startPictureScan(now: number = Date.now()): PictureScan {
  return {
    remaining: MAX_PDF_PICTURES,
    deadline: now + PICTURE_SCAN_BUDGET_MS,
    seen: new Map(),
  };
}

/** How far apart, in points, two draws of the same picture may be and still
 *  be "the same place" — a letterhead is placed by the same template on every
 *  page, to well within this. */
const SAME_PLACE_PT = 1;

/** Whether `box` repeats a draw of the same picture at the same place on
 *  ANOTHER page: page chrome (a letterhead, a footer logo), not content. */
function isChromeRepeat(seen: SeenPicture, box: DrawnBox): boolean {
  return seen.boxes.some(
    (b) =>
      b.page !== box.page &&
      Math.abs(b.left - box.left) <= SAME_PLACE_PT &&
      Math.abs(b.bottom - box.bottom) <= SAME_PLACE_PT &&
      Math.abs(b.width - box.width) <= SAME_PLACE_PT &&
      Math.abs(b.height - box.height) <= SAME_PLACE_PT,
  );
}

/** Whether page `page` (1-based) may still be searched. */
export function pictureScanOpen(scan: PictureScan, page: number): boolean {
  return (
    scan.remaining > 0 &&
    page <= MAX_PICTURE_SCAN_PAGES &&
    Date.now() <= scan.deadline
  );
}

/**
 * The line a picture occupies in the extracted text until the ingest knows
 * where the picture was stored. Brackets a text layer practically never
 * produces, so the token cannot be mistaken for the document's own words, and
 * ONE line, so replacing it never moves the page-marker lines an outline
 * cites.
 */
export function pictureToken(id: number): string {
  return `⟦picture:${id}⟧`;
}

/** Matches every token `pictureToken` writes; group 1 is the id. */
export const PICTURE_TOKEN = /⟦picture:(\d+)⟧/g;

/** The slice of a pdfjs page this module reads. Structural, so a test can hand
 *  over a stub and the module never imports pdfjs at runtime. */
export interface PicturePage {
  getOperatorList(): Promise<{
    readonly fnArray: ArrayLike<number>;
    readonly argsArray: ArrayLike<unknown>;
  }>;
  readonly objs: PictureObjects;
  readonly commonObjs: PictureObjects;
  /** The page box, [x0, y0, x1, y1] in user space. */
  readonly view: ArrayLike<number>;
}

interface PictureObjects {
  get(objId: string, callback: (data: unknown) => void): unknown;
}

type Matrix = readonly [number, number, number, number, number, number];

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

/** `m1 · m2` in the canvas convention pdfjs's own `Util.transform` uses: apply
 *  `m2` first, then `m1`. */
function multiply(m1: Matrix, m2: Matrix): Matrix {
  return [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
  ];
}

function asMatrix(v: unknown): Matrix | undefined {
  if (!Array.isArray(v) && !ArrayBuffer.isView(v)) return undefined;
  const a = v as ArrayLike<unknown>;
  if (a.length < 6) return undefined;
  const m = [a[0], a[1], a[2], a[3], a[4], a[5]];
  return m.every((n) => typeof n === "number" && Number.isFinite(n))
    ? (m as unknown as Matrix)
    : undefined;
}

/** Back to the event loop. */
function nextTurn(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

/** A checkpoint for a pixel loop: resolves at once until the loop has held
 *  the main process for `SLICE_MS`, then yields one turn of the event loop. */
function yielder(): () => Promise<void> {
  let since = performance.now();
  return async () => {
    if (performance.now() - since < SLICE_MS) return;
    await nextTurn();
    since = performance.now();
  };
}

/**
 * The pictures `page` draws, top to bottom (left to right on a tie).
 *
 * Walks the operator list keeping the current transformation matrix — an image
 * operator draws into the unit square of whatever matrix is current — through
 * save/restore, `cm`, groups and form XObjects' own matrices. Pictures inside
 * annotations are skipped (chrome, not content), as are tiled images and
 * stencil masks (a mask is a shape filled with the current colour, not a
 * picture). An object id beginning `g_` lives in the document-wide store — the
 * same rule pdfjs's own canvas code follows.
 *
 * A picture covering most of a page that has text (`FULL_PAGE_SHARE`) is left
 * out before any pixel is read. A picture whose pixels the document already
 * showed is never encoded again, and never spends `MAX_PDF_PICTURES`; what it
 * becomes depends on where it is drawn (2026-10-01). At the same place as on
 * an earlier page it is page chrome — a letterhead, a footer logo — and adds
 * no line: its first appearance keeps the only one. Anywhere else it is
 * content used twice, a formula two questions both show, and it gets a line
 * there too, citing the same stored file and transcript. (The first cut of
 * this rule dropped every repeat, which took the second question's formula
 * with the letterhead.)
 *
 * Never throws: a page whose operator list will not build, or a picture that
 * will not decode, just contributes fewer pictures — the text is the
 * attachment.
 */
export async function collectPagePictures(
  page: PicturePage,
  pdfjs: Pick<PdfJs, "OPS" | "ImageKind">,
  scan: PictureScan,
  opts: {
    readonly pageHasText: boolean;
    /** 1-based; tells a letterhead (same place, another page) from content
     *  used twice. */
    readonly page: number;
  },
): Promise<PagePicture[]> {
  const { OPS } = pdfjs;
  let list: Awaited<ReturnType<PicturePage["getOperatorList"]>>;
  try {
    list = await page.getOperatorList();
  } catch {
    return [];
  }
  const draws: Array<{ readonly ref: unknown; readonly ctm: Matrix }> = [];
  const stack: Matrix[] = [];
  let ctm = IDENTITY;
  let annotationDepth = 0;
  for (let k = 0; k < list.fnArray.length; k += 1) {
    const fn = list.fnArray[k];
    const args = list.argsArray[k];
    if (fn === OPS.save || fn === OPS.beginGroup) {
      stack.push(ctm);
    } else if (
      fn === OPS.restore ||
      fn === OPS.endGroup ||
      fn === OPS.paintFormXObjectEnd
    ) {
      ctm = stack.pop() ?? ctm;
    } else if (fn === OPS.transform) {
      const m = asMatrix(args);
      if (m !== undefined) ctm = multiply(ctm, m);
    } else if (fn === OPS.paintFormXObjectBegin) {
      stack.push(ctm);
      const m = asMatrix(Array.isArray(args) ? args[0] : undefined);
      if (m !== undefined) ctm = multiply(ctm, m);
    } else if (fn === OPS.beginAnnotation) {
      annotationDepth += 1;
      stack.push(ctm);
    } else if (fn === OPS.endAnnotation) {
      annotationDepth = Math.max(0, annotationDepth - 1);
      ctm = stack.pop() ?? ctm;
    } else if (
      (fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject) &&
      annotationDepth === 0
    ) {
      draws.push({ ref: Array.isArray(args) ? args[0] : undefined, ctm });
    }
  }

  const view = page.view;
  const pageArea = Math.abs(
    ((view[2] ?? 0) - (view[0] ?? 0)) * ((view[3] ?? 0) - (view[1] ?? 0)),
  );
  const pictures: PagePicture[] = [];
  for (const draw of draws) {
    if (scan.remaining <= 0 || Date.now() > scan.deadline) break;
    const m = draw.ctm;
    // The unit square's corners under the matrix; rotation and skew included.
    const xs = [m[4], m[0] + m[4], m[2] + m[4], m[0] + m[2] + m[4]];
    const ys = [m[5], m[1] + m[5], m[3] + m[5], m[1] + m[3] + m[5]];
    const left = Math.min(...xs);
    const width = Math.max(...xs) - left;
    const bottom = Math.min(...ys);
    const top = Math.max(...ys);
    if (width < MIN_PICTURE_DRAWN_PT || top - bottom < MIN_PICTURE_DRAWN_PT) {
      continue;
    }
    if (
      opts.pageHasText &&
      pageArea > 0 &&
      width * (top - bottom) >= FULL_PAGE_SHARE * pageArea
    ) {
      continue;
    }
    // One picture per turn of the event loop, whatever each one costs.
    await nextTurn();
    const data =
      typeof draw.ref === "string"
        ? await objectData(
            draw.ref.startsWith("g_") ? page.commonObjs : page.objs,
            draw.ref,
          )
        : draw.ref;
    const key = await pixelKey(data);
    if (key === null) continue;
    const box: DrawnBox = {
      page: opts.page,
      left,
      bottom,
      width,
      height: top - bottom,
    };
    const seen = scan.seen.get(key);
    if (seen !== undefined) {
      // Never encoded twice, never counted twice; chrome adds no line.
      const chrome = isChromeRepeat(seen, box);
      seen.boxes.push(box);
      if (!chrome) pictures.push({ png: seen.png, top, bottom, left });
      continue;
    }
    let png: Buffer | null;
    try {
      png = await encodePicture(data, pdfjs.ImageKind);
    } catch {
      png = null;
    }
    if (png === null) continue;
    scan.seen.set(key, { png, boxes: [box] });
    scan.remaining -= 1;
    pictures.push({ png, top, bottom, left });
  }
  return pictures.sort((a, b) => b.top - a.top || a.left - b.left);
}

/** pdfjs resolves an image object once the worker has decoded it; the callback
 *  form waits for that. Bounded, so a picture the worker never delivers cannot
 *  hang the ingest. */
function objectData(store: PictureObjects, id: string): Promise<unknown> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), OBJECT_WAIT_MS);
    try {
      store.get(id, (data) => {
        clearTimeout(timer);
        resolve(data);
      });
    } catch {
      clearTimeout(timer);
      resolve(null);
    }
  });
}

/** Identity of a decoded picture's PIXELS — the same image drawn twice, or
 *  stored twice under different object ids, has one key. Hashed by WebCrypto,
 *  which runs off the main thread. Null for anything that is not pixels. */
async function pixelKey(data: unknown): Promise<string | null> {
  if (typeof data !== "object" || data === null) return null;
  const img = data as {
    width?: unknown;
    height?: unknown;
    kind?: unknown;
    data?: unknown;
  };
  if (
    !(img.data instanceof Uint8Array || img.data instanceof Uint8ClampedArray)
  ) {
    return null;
  }
  // pdfjs's image data is backed by a plain ArrayBuffer (never shared memory),
  // which is what WebCrypto's BufferSource asks for.
  const digest = await crypto.subtle.digest(
    "SHA-256",
    img.data as Uint8Array<ArrayBuffer>,
  );
  return `${String(img.width)}x${String(img.height)}/${String(img.kind)}/${Buffer.from(digest).toString("hex")}`;
}

/**
 * A decoded pdfjs image as a PNG, or null for a shape it does not recognize.
 *
 * pdfjs hands image data over in one of three layouts (`ImageKind`): 1 bit per
 * pixel with byte-aligned rows, where a set bit is WHITE (pdfjs's own
 * `convertBlackAndWhiteToRGBA` default); 8-bit RGB; 8-bit RGBA, soft mask
 * already applied. A `bitmap` (what the browser build hands a canvas) is not
 * pixels this side can read, so it is skipped.
 *
 * Asynchronous on purpose: the compression runs on the thread pool and every
 * pixel loop yields after `SLICE_MS`. Encoded synchronously, one page scanned
 * at 300 dpi held the main process for 0.4–0.5 s (review on #6).
 */
export async function encodePicture(
  data: unknown,
  kinds: PdfJs["ImageKind"],
): Promise<Buffer | null> {
  if (typeof data !== "object" || data === null) return null;
  const img = data as {
    width?: unknown;
    height?: unknown;
    kind?: unknown;
    data?: unknown;
    bitmap?: unknown;
  };
  const { width, height } = img;
  if (img.bitmap !== undefined && img.bitmap !== null) return null;
  if (
    typeof width !== "number" ||
    typeof height !== "number" ||
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < MIN_PICTURE_SIDE_PX ||
    height < MIN_PICTURE_SIDE_PX ||
    !(img.data instanceof Uint8Array || img.data instanceof Uint8ClampedArray)
  ) {
    return null;
  }
  const checkpoint = yielder();
  const src = img.data;
  let channels: 1 | 3 | 4;
  let pixels: Uint8Array | Uint8ClampedArray;
  if (img.kind === kinds.RGBA_32BPP) {
    channels = 4;
    pixels = src;
  } else if (img.kind === kinds.RGB_24BPP) {
    channels = 3;
    pixels = src;
  } else if (img.kind === kinds.GRAYSCALE_1BPP) {
    channels = 1;
    const stride = (width + 7) >> 3;
    if (src.length < stride * height) return null;
    const gray = new Uint8Array(width * height);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const bit = ((src[y * stride + (x >> 3)] ?? 0) >> (7 - (x & 7))) & 1;
        gray[y * width + x] = bit === 1 ? 255 : 0;
      }
      await checkpoint();
    }
    pixels = gray;
  } else {
    return null;
  }
  if (pixels.length < width * height * channels) return null;

  let w = width;
  let h = height;
  const factor = Math.ceil(Math.max(width, height) / MAX_PICTURE_SIDE_PX);
  if (factor > 1) {
    const scaled = await downscale(
      pixels,
      width,
      height,
      channels,
      factor,
      checkpoint,
    );
    pixels = scaled.pixels;
    w = scaled.width;
    h = scaled.height;
  }
  return pngOf(pixels, w, h, channels, checkpoint);
}

/** Box filter by an integer factor: each output pixel is the mean of the
 *  (up to) factor×factor block it covers. */
async function downscale(
  pixels: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  channels: number,
  factor: number,
  checkpoint: () => Promise<void>,
): Promise<{ pixels: Uint8Array; width: number; height: number }> {
  const w = Math.ceil(width / factor);
  const h = Math.ceil(height / factor);
  const out = new Uint8Array(w * h * channels);
  const sums = new Float64Array(channels);
  for (let y = 0; y < h; y += 1) {
    const y1 = Math.min(height, (y + 1) * factor);
    for (let x = 0; x < w; x += 1) {
      const x1 = Math.min(width, (x + 1) * factor);
      sums.fill(0);
      let n = 0;
      for (let yy = y * factor; yy < y1; yy += 1) {
        for (let xx = x * factor; xx < x1; xx += 1) {
          const i = (yy * width + xx) * channels;
          for (let c = 0; c < channels; c += 1) {
            sums[c] = (sums[c] ?? 0) + (pixels[i + c] ?? 0);
          }
          n += 1;
        }
      }
      const o = (y * w + x) * channels;
      for (let c = 0; c < channels; c += 1) {
        out[o + c] = Math.round((sums[c] ?? 0) / n);
      }
    }
    await checkpoint();
  }
  return { pixels: out, width: w, height: h };
}

/** An 8-bit PNG: gray (1 channel), RGB (3) or RGBA (4); filter 0 on every row.
 *  The deflate runs on the thread pool. */
async function pngOf(
  pixels: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  channels: 1 | 3 | 4,
  checkpoint: () => Promise<void>,
): Promise<Buffer> {
  const rowBytes = width * channels;
  const raw = Buffer.alloc((rowBytes + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw.set(
      pixels.subarray(y * rowBytes, (y + 1) * rowBytes),
      y * (rowBytes + 1) + 1,
    );
    await checkpoint();
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = channels === 4 ? 6 : channels === 3 ? 2 : 0;
  const idat = await deflateAsync(raw);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function chunk(type: string, body: Buffer): Buffer {
  const typed = Buffer.concat([Buffer.from(type, "latin1"), body]);
  const out = Buffer.alloc(8 + body.length + 4);
  out.writeUInt32BE(body.length, 0);
  typed.copy(out, 4);
  out.writeUInt32BE(crc32(typed) >>> 0, 8 + body.length);
  return out;
}

/** A text line of a page and the baseline its first visible item sits on. */
export interface BaselinedLine {
  readonly text: string;
  readonly baseline: number | undefined;
}

/**
 * The page's lines with each picture's token on a line of its own, after the
 * last line that sits at or above the picture's bottom edge.
 *
 * pdfjs lists text in content-stream order, and a Word export draws every
 * picture after all of a page's text, so position — not stream order — is what
 * places a picture. The scan walks the lines in the order they are written and
 * slots the picture before the first line that falls below its bottom edge,
 * once some line has been seen above it; a line with no visible text borrows
 * the baseline before it. A picture above every line opens the page; one below
 * every line closes it. Single-column reading order is the assumption — a
 * two-column page can put a picture in the wrong column's run.
 */
export function slotPictures(
  lines: readonly BaselinedLine[],
  pictures: ReadonlyArray<{ readonly id: number; readonly bottom: number }>,
): string[] {
  const baselines: Array<number | undefined> = [];
  let last: number | undefined;
  for (const line of lines) {
    if (line.baseline !== undefined) last = line.baseline;
    baselines.push(last);
  }
  const slots: string[][] = Array.from({ length: lines.length + 1 }, () => []);
  for (const picture of pictures) {
    let at = lines.length;
    let seenAbove = false;
    for (let i = 0; i < lines.length; i += 1) {
      const y = baselines[i];
      if (y === undefined) continue;
      if (y >= picture.bottom) {
        seenAbove = true;
      } else if (seenAbove) {
        at = i;
        break;
      }
    }
    if (!seenAbove) at = 0;
    slots[at]?.push(pictureToken(picture.id));
  }
  const out: string[] = [];
  for (let i = 0; i <= lines.length; i += 1) {
    out.push(...(slots[i] ?? []));
    const line = lines[i];
    if (line !== undefined) out.push(line.text);
  }
  return out;
}
