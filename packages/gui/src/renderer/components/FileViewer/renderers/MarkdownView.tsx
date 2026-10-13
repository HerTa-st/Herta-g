import { Marked } from "marked";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useT } from "../../../i18n/LocaleProvider.js";
import type { ViewerAnchor } from "../file-viewer-context.js";
import {
  type MaskPiece,
  PieceMask,
  type PieceQuoting,
  quotesFromRuns,
} from "../PieceQuote.js";
import {
  type MarkdownBlock,
  markdownBlocks,
  markdownSections,
} from "../piece-segments.js";
import { sanitizedFragment, setSanitizedHtml } from "./dom-html.js";

/**
 * Markdown as the page (ADR 0054 §4): `marked` (GFM) → DOMPurify → DOM,
 * then two passes over the fences — ```mermaid becomes a diagram (lazy
 * chunk, strict security level) and every other fence gets highlight.js
 * tokens when its language is known. Both passes are async and keyed to
 * the content they were started for, so a file switched mid-render never
 * paints into the wrong document. Each block keeps the source lines it
 * came from, so a cite lands on the page too.
 */
const marked = new Marked({ gfm: true, breaks: false, async: false });

/** Fences above this many are left plain — a generated dump with hundreds
 *  of code blocks is not a page anyone reads token by token. */
const MAX_HIGHLIGHTED_FENCES = 200;
const MAX_DIAGRAMS = 40;

function fenceLanguage(code: HTMLElement): string | null {
  const cls = [...code.classList].find((c) => c.startsWith("language-"));
  return cls === undefined ? null : cls.slice("language-".length);
}

/** How far the cite band reaches past the blocks it covers. */
const BAND_PAD = 3;

/**
 * Marks each top-level block of the rendered page — and each item of a
 * list — with the source lines it came from (`data-lines`). False when the
 * page's elements do not match the lexer's blocks one for one (raw HTML
 * that wraps what follows it, say); nothing is marked then.
 */
function markBlockLines(
  doc: HTMLElement,
  blocks: readonly MarkdownBlock[],
): boolean {
  const owners: MarkdownBlock[] = [];
  for (const b of blocks) {
    const n =
      b.html === undefined ? 1 : sanitizedFragment(b.html).children.length;
    for (let i = 0; i < n; i++) owners.push(b);
  }
  const els = Array.from(doc.children) as HTMLElement[];
  if (els.length !== owners.length) return false;
  els.forEach((el, i) => {
    const b = owners[i] as MarkdownBlock;
    el.dataset.lines = `${b.from}-${b.to}`;
    const items = Array.from(el.children) as HTMLElement[];
    if (
      b.items !== undefined &&
      /^(UL|OL)$/.test(el.tagName) &&
      items.length === b.items.length
    ) {
      items.forEach((li, k) => {
        const r = b.items?.[k];
        if (r !== undefined) li.dataset.lines = `${r.from}-${r.to}`;
      });
    }
  });
  return true;
}

function linesOf(el: HTMLElement): { from: number; to: number } | null {
  const m = /^(\d+)-(\d+)$/.exec(el.dataset.lines ?? "");
  return m === null ? null : { from: Number(m[1]), to: Number(m[2]) };
}

/** The band over the marked blocks a cite touches — a list narrowed to its
 *  items — in the host's coordinates; null when it touches none. */
function bandOver(
  host: HTMLElement,
  doc: HTMLElement,
  anchor: ViewerAnchor,
): { top: number; height: number } | null {
  const origin = host.getBoundingClientRect().top;
  let top = Number.POSITIVE_INFINITY;
  let bottom = Number.NEGATIVE_INFINITY;
  for (const block of doc.querySelectorAll<HTMLElement>(
    ":scope > [data-lines]",
  )) {
    const items = block.querySelectorAll<HTMLElement>(":scope > [data-lines]");
    for (const el of items.length > 0 ? Array.from(items) : [block]) {
      const r = linesOf(el);
      if (r === null || r.to < anchor.from || r.from > anchor.to) continue;
      const rect = el.getBoundingClientRect();
      top = Math.min(top, rect.top - origin);
      bottom = Math.max(bottom, rect.bottom - origin);
    }
  }
  if (top === Number.POSITIVE_INFINITY) return null;
  return { top: top - BAND_PAD, height: bottom - top + 2 * BAND_PAD };
}

export function MarkdownView({
  content,
  truncated,
  piece,
  anchor,
  onAnchorUnmapped,
}: {
  readonly content: string;
  readonly truncated: boolean;
  /** Piece quoting (ADR 0078); absent where the panel offers none. */
  readonly piece?: PieceQuoting | undefined;
  /** A cite's lines: the band lands on the blocks they render to. */
  readonly anchor?: ViewerAnchor | undefined;
  /** The page's blocks could not be matched to its lines, so the cite has
   *  nowhere to land here; the panel shows the source instead. */
  readonly onAnchorUnmapped?: (() => void) | undefined;
}): JSX.Element {
  const t = useT();
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const diagramFailedLabel = t("viewer.diagramFailed");
  const lines = useMemo(() => content.split("\n"), [content]);
  const mapped = useRef(false);
  const [band, setBand] = useState<{ top: number; height: number } | null>(
    null,
  );

  // The pieces (ADR 0078 §2): the source's sections, laid over the page's
  // top-level blocks — a section starts at its heading, and its seam sits
  // halfway through the gap before it. A page whose headings do not match
  // the source's one for one is one piece.
  const measurePieces = useCallback((): readonly MaskPiece[] => {
    const host = hostRef.current;
    const doc = bodyRef.current;
    if (host === null || doc === null) return [];
    const sections = markdownSections(content);
    const blocks = Array.from(doc.children) as HTMLElement[];
    const headings = blocks.filter((b) => /^H[1-6]$/.test(b.tagName));
    const titled = sections.filter((s) => s.title !== undefined);
    const total = host.offsetHeight;
    if (sections.length === 0) return [];
    if (headings.length !== titled.length) {
      return [{ top: 0, height: total, from: 1, to: lines.length }];
    }
    const preamble = sections.length > titled.length;
    const starts = [...(preamble ? [blocks[0]] : []), ...headings];
    const tops = starts.map((el, i) => {
      if (i === 0 || el === undefined) return 0;
      const prev = el.previousElementSibling as HTMLElement | null;
      const gapTop =
        prev === null ? el.offsetTop : prev.offsetTop + prev.offsetHeight;
      return (gapTop + el.offsetTop) / 2;
    });
    return sections.map((s, i) => {
      const top = tops[i] ?? 0;
      const bottom = tops[i + 1] ?? total;
      return {
        top,
        height: bottom - top,
        from: s.from,
        to: s.to,
        ...(s.title !== undefined ? { title: s.title } : {}),
      };
    });
  }, [content, lines]);
  const quotePieces = useCallback(
    (runs: readonly (readonly MaskPiece[])[]): void => {
      if (piece === undefined) return;
      piece.onQuote(quotesFromRuns(runs, lines, piece.path, piece.lang, "md"));
    },
    [piece, lines],
  );

  useEffect(() => {
    const root = bodyRef.current;
    if (root === null) return;
    let alive = true;
    const html = marked.parse(content) as string;
    const frag = sanitizedFragment(html);
    root.replaceChildren(frag);
    mapped.current = markBlockLines(root, markdownBlocks(content));

    // Fences: diagrams first (they replace the block), then tokens.
    const fences = [...root.querySelectorAll<HTMLElement>("pre > code")];
    const diagrams = fences
      .filter((c) => fenceLanguage(c) === "mermaid")
      .slice(0, MAX_DIAGRAMS);
    const others = fences
      .filter((c) => fenceLanguage(c) !== "mermaid")
      .slice(0, MAX_HIGHLIGHTED_FENCES);

    if (diagrams.length > 0) {
      void import("./mermaid-render.js").then(
        async ({ renderMermaid }) => {
          for (const code of diagrams) {
            if (!alive) return;
            const pre = code.parentElement;
            if (pre === null) continue;
            const source = code.textContent ?? "";
            try {
              const svg = await renderMermaid(source);
              if (!alive) return;
              const figure = document.createElement("figure");
              figure.className = "file-viewer__diagram";
              if (pre.dataset.lines !== undefined)
                figure.dataset.lines = pre.dataset.lines;
              figure.append(svg);
              pre.replaceWith(figure);
            } catch {
              if (!alive) return;
              // The source stays visible, labeled honestly — never a blank
              // hole where a diagram was promised.
              const note = document.createElement("p");
              note.className = "file-viewer__diagram-failed";
              note.textContent = diagramFailedLabel;
              pre.before(note);
            }
          }
        },
        () => undefined,
      );
    }

    if (others.length > 0) {
      void import("./highlight.js").then(
        (h) => {
          if (!alive) return;
          for (const code of others) {
            const lang = fenceLanguage(code);
            if (lang === null) continue;
            const html = h.highlightToHtml(code.textContent ?? "", lang);
            if (html !== null) setSanitizedHtml(code, html);
          }
        },
        () => undefined,
      );
    }

    return () => {
      alive = false;
    };
  }, [content, diagramFailedLabel]);

  // Cite anchor (ADR 0054, amended 2026-10-13): a band over the blocks the
  // cited lines render to, scrolled a third of the way down as the source
  // view does. The page can still grow under it (a diagram drawn, an image
  // loaded), so the band follows its size, and so does the scroll until
  // the reader scrolls themselves.
  const unmapped = useRef(onAnchorUnmapped);
  unmapped.current = onAnchorUnmapped;
  // biome-ignore lint/correctness/useExhaustiveDependencies: `content` re-runs it once the page is re-rendered and re-marked
  useEffect(() => {
    const host = hostRef.current;
    const doc = bodyRef.current;
    const scroller = scrollerRef.current;
    if (
      anchor === undefined ||
      host === null ||
      doc === null ||
      scroller === null
    ) {
      setBand(null);
      return;
    }
    if (!mapped.current) {
      setBand(null);
      unmapped.current?.();
      return;
    }
    let placedAt: number | null = null;
    const place = (): void => {
      const next = bandOver(host, doc, anchor);
      setBand(next);
      if (next === null) return;
      if (placedAt !== null && Math.abs(scroller.scrollTop - placedAt) > 1)
        return;
      const hostTop =
        host.getBoundingClientRect().top -
        scroller.getBoundingClientRect().top +
        scroller.scrollTop;
      scroller.scrollTop = Math.max(
        0,
        hostTop + next.top - scroller.clientHeight * 0.3,
      );
      placedAt = scroller.scrollTop;
    };
    place();
    if (typeof ResizeObserver === "undefined") return;
    const follow = new ResizeObserver(place);
    follow.observe(doc);
    return () => follow.disconnect();
  }, [anchor, content]);

  return (
    <div className="file-viewer__body">
      <div ref={scrollerRef} className="file-viewer__scroll">
        <div ref={hostRef} className="file-viewer__doc-host">
          {band !== null && (
            <div
              className="file-viewer__anchor"
              style={{ top: band.top, height: band.height }}
              aria-hidden="true"
            />
          )}
          <div ref={bodyRef} className="file-viewer__doc" />
          {piece !== undefined && (
            <PieceMask
              enabled={piece.enabled}
              hostRef={hostRef}
              scrollerRef={scrollerRef}
              measure={measurePieces}
              onQuote={quotePieces}
              resetKey={content}
            />
          )}
        </div>
      </div>
      {truncated && (
        <p className="file-viewer__notice">{t("viewer.truncatedNote")}</p>
      )}
    </div>
  );
}
