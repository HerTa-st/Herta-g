import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useT } from "../../../i18n/LocaleProvider.js";
import type { ViewerAnchor } from "../file-viewer-context.js";
import {
  type MaskPiece,
  PieceMask,
  type PieceQuoting,
  quotesFromRuns,
} from "../PieceQuote.js";
import { codePieces } from "../piece-segments.js";
import { sanitizedFragment, setSanitizedHtml } from "./dom-html.js";
import { chunkLines, splitHighlightHtml } from "./highlight-chunks.js";
import { viewerHighlighter } from "./highlighter.js";

/**
 * The ADR 0050 text layout — gutter + `<pre>` over one relative box with
 * the cite-anchor band — now with highlight.js tokens when the kind names
 * a language (ADR 0054 §4). The highlighter runs on its own thread (ADR
 * 0068 §12; `highlighter.ts`, with the lazy main-thread chunk as its
 * fallback): a plain text file paints synchronously as before, and a code
 * file paints plain first and colors in when the answer lands (a local read
 * answers in single-digit milliseconds; the worker starts once).
 *
 * The text is rendered as BLOCKS of `LINES_PER_CHUNK` lines (ADR 0068 §13),
 * and the answer's tokens replace the plain text one block at a time, a
 * frame's budget per turn: one `<pre>` of 29K spans adopted at once cost
 * DOMPurify 437 ms, layout 525 ms and a first frame near a second at the
 * viewer's cap; a block re-lays out alone, and the swap never moves a line.
 */

/** Rendered-line cap: a 1.5MB log is ~30k lines and 30k gutter rows of DOM
 *  helps nobody — the panel shows the head and says the file continues. */
export const MAX_RENDER_LINES = 8_000;

/** Fallback line height when the computed style is unreadable (jsdom) —
 *  the CSS pins 12px × 1.6. */
const FALLBACK_LINE_H = 19.2;

/** Main-thread budget of one turn of the progressive adoption — the time
 *  spent sanitizing before the turn yields; the chunk's layout follows in
 *  the same frame. A cap-size chunk sanitizes in ~12 ms in the app and lays
 *  out in about as much, so this is one chunk per frame there (a turn that
 *  took two measured 46 ms; one takes ~25) and several per frame for an
 *  ordinary file's small chunks. The first turn runs right away, in the
 *  answer's own task. */
const ADOPT_BUDGET_MS = 4;

/**
 * Run `fn` on the next frame — or after a short timer where frames are not
 * being produced (an occluded window pauses requestAnimationFrame; jsdom has
 * none). Returns the cancel.
 */
function onNextFrame(fn: () => void): () => void {
  let done = false;
  const run = (): void => {
    if (done) return;
    done = true;
    fn();
  };
  const raf =
    typeof requestAnimationFrame === "function"
      ? requestAnimationFrame(run)
      : undefined;
  const timer = setTimeout(run, 32);
  return () => {
    done = true;
    if (raf !== undefined) cancelAnimationFrame(raf);
    clearTimeout(timer);
  };
}

/**
 * Swap each chunk's plain text for its tokens, a frame's budget at a time
 * (ADR 0068 §13). The answer is cut at the chunks' own line boundaries, so
 * chunk k's tokens are exactly chunk k's lines and nothing moves; each
 * piece goes through the one door (`sanitizedFragment`) on its own. An
 * answer that is not highlight.js's shape, or one whose piece count no
 * longer matches the blocks, is adopted whole as before. A chunk that has
 * left the `<pre>` (the text changed under a late answer) is left alone.
 * Returns the cancel.
 */
function adoptHighlight(pre: HTMLPreElement, html: string): () => void {
  const pieces = splitHighlightHtml(html);
  const chunks = Array.from(pre.children);
  if (pieces === null || pieces.length !== chunks.length) {
    setSanitizedHtml(pre, html);
    return () => undefined;
  }
  let k = 0;
  let cancelFrame: (() => void) | undefined;
  const step = (): void => {
    const deadline = performance.now() + ADOPT_BUDGET_MS;
    do {
      const piece = pieces[k];
      const chunk = chunks[k];
      if (piece === undefined || chunk === undefined) break;
      if (chunk.parentNode === pre) {
        chunk.replaceChildren(sanitizedFragment(piece.html));
      }
      k += 1;
    } while (k < pieces.length && performance.now() < deadline);
    if (k < pieces.length) cancelFrame = onNextFrame(step);
  };
  step();
  return () => cancelFrame?.();
}

export function CodeView({
  content,
  truncated,
  language,
  anchor,
  piece,
}: {
  readonly content: string;
  readonly truncated: boolean;
  /** highlight.js language id; undefined = plain text. */
  readonly language?: string | undefined;
  readonly anchor?: ViewerAnchor | undefined;
  /** Piece quoting (ADR 0078); absent where the panel offers none. */
  readonly piece?: PieceQuoting | undefined;
}): JSX.Element {
  const t = useT();
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const innerRef = useRef<HTMLDivElement | null>(null);
  const textRef = useRef<HTMLPreElement | null>(null);
  const [band, setBand] = useState<{
    readonly top: number;
    readonly height: number;
  } | null>(null);

  // Once per CONTENT, not per render: the panel re-renders on every pointer
  // move of its divider and every frame of a sidebar slide (its width is
  // state), and this split / slice / join / gutter build runs over up to
  // 300K characters and 8 000 lines (perf audit 2026-09-20).
  const { elided, lineCount, shown, gutter, chunks, lines } = useMemo(() => {
    const allLines = content.split("\n");
    const lines = allLines.slice(0, MAX_RENDER_LINES);
    return {
      elided: allLines.length - lines.length,
      lineCount: lines.length,
      shown: lines.join("\n"),
      gutter: lines.map((_, i) => i + 1).join("\n"),
      chunks: chunkLines(lines),
      lines,
    };
  }, [content]);

  // The pieces (ADR 0078 §2): runs of lines to their blank line, laid out
  // by the same line metrics the cite band uses, full width, gutter and all.
  const measurePieces = useCallback((): readonly MaskPiece[] => {
    const inner = innerRef.current;
    const text = textRef.current;
    if (inner === null || text === null) return [];
    const cs = getComputedStyle(text);
    const lh = Number.parseFloat(cs.lineHeight) || FALLBACK_LINE_H;
    const padTop = Number.parseFloat(cs.paddingTop) || 0;
    const ranges = codePieces(lines);
    const tops = ranges.map((r, i) =>
      i === 0 ? 0 : padTop + (r.from - 1) * lh,
    );
    return ranges.map((r, i) => {
      const top = tops[i] ?? 0;
      const bottom = tops[i + 1] ?? inner.offsetHeight;
      return { top, height: bottom - top, from: r.from, to: r.to };
    });
  }, [lines]);
  const quotePieces = useCallback(
    (runs: readonly (readonly MaskPiece[])[]): void => {
      if (piece === undefined) return;
      piece.onQuote(
        quotesFromRuns(runs, lines, piece.path, piece.lang, language),
      );
    },
    [piece, lines, language],
  );

  // Plain text first (synchronous, so the first paint and the anchor
  // metrics never wait on the highlighter), as blocks the tokens will land
  // in one by one; the answer for THIS content replaces them — a stale
  // answer for a previous file is dropped, and its adoption cancelled.
  useLayoutEffect(() => {
    const pre = textRef.current;
    if (pre === null) return;
    pre.replaceChildren(
      ...chunks.map((text) => {
        const div = document.createElement("div");
        div.className = "file-viewer__chunk";
        div.textContent = text;
        return div;
      }),
    );
  }, [chunks]);
  useEffect(() => {
    if (language === undefined) return;
    let alive = true;
    let cancel: (() => void) | undefined;
    void viewerHighlighter.highlight(shown, language).then((html) => {
      if (!alive || html === null) return;
      const pre = textRef.current;
      if (pre !== null) cancel = adoptHighlight(pre, html);
    });
    return () => {
      alive = false;
      cancel?.();
    };
  }, [shown, language]);

  // Cite anchor (ADR 0050 v1.5): a highlight band positioned by line
  // metrics, and a scroll that puts the cited lines a third of the way
  // down. Layout effect so the first paint already shows the band.
  useLayoutEffect(() => {
    if (anchor === undefined || anchor.from > lineCount) {
      setBand(null);
      return;
    }
    const scroller = scrollerRef.current;
    const text = textRef.current;
    if (scroller === null || text === null) return;
    const cs = getComputedStyle(text);
    const lh = Number.parseFloat(cs.lineHeight) || FALLBACK_LINE_H;
    const padTop = Number.parseFloat(cs.paddingTop) || 0;
    const from = Math.max(1, anchor.from);
    const to = Math.min(Math.max(anchor.to, from), lineCount);
    const top = padTop + (from - 1) * lh;
    setBand({ top, height: (to - from + 1) * lh });
    scroller.scrollTop = Math.max(0, top - scroller.clientHeight * 0.3);
  }, [anchor, lineCount]);

  return (
    <div className="file-viewer__body">
      <div ref={scrollerRef} className="file-viewer__code">
        <div ref={innerRef} className="file-viewer__code-inner">
          {band !== null && (
            <div
              className="file-viewer__anchor"
              style={{ top: band.top, height: band.height }}
              aria-hidden="true"
            />
          )}
          <pre className="file-viewer__gutter" aria-hidden="true">
            {gutter}
          </pre>
          <pre ref={textRef} className="file-viewer__text" />
          {piece !== undefined && (
            <PieceMask
              enabled={piece.enabled}
              hostRef={innerRef}
              scrollerRef={scrollerRef}
              measure={measurePieces}
              onQuote={quotePieces}
              resetKey={content}
            />
          )}
        </div>
      </div>
      {(truncated || elided > 0) && (
        <p className="file-viewer__notice">{t("viewer.truncatedNote")}</p>
      )}
    </div>
  );
}
