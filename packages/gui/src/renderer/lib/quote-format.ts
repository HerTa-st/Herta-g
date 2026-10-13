/**
 * A quote the Trailblazer picked from the viewer's page (ADR 0078 §4–§7):
 * a file's lines, carried to Herta as the Trailblazer's own words.
 *
 * In the message it is a header line and a fence, at the front:
 *
 *   〔引用 src/calc.js:9–14〕
 *   ```js
 *   export function div(a, b) {
 *   …
 *   ```
 *
 * Herta has no tools, so the source itself rides the record (D7); 板砖
 * reads it the same way when the message calls him. The bubble reads the
 * same shape back into a card (`parseLeadingQuotes`). Pure.
 */

import { makeT } from "../i18n/LocaleProvider.js";

export interface ComposerQuote {
  readonly id: string;
  /** Workspace-relative, forward slashes. */
  readonly path: string;
  readonly from: number;
  readonly to: number;
  /** A markdown section's heading. */
  readonly title?: string;
  /** The source of those lines, bounded (`boundQuoteText`). */
  readonly text: string;
  /** The fence's language tag, when the file has one. */
  readonly fence?: string;
}

export const QUOTE_MAX_LINES = 200;
export const QUOTE_MAX_CHARS = 8_000;

/** The header's word is the message's own language, so it comes from the
 *  session-language catalogs (`makeT`), never the UI locale; the parser
 *  knows both. The brackets are structure, not copy: U+3014 / U+3015. */
const OPEN = "\u3014";
const CLOSE = "\u3015";
const headerWord = (lang: "zh" | "en"): string => makeT(lang)("quote.header");
const HEADER = new RegExp(
  `^${OPEN}(?:${headerWord("zh")}|${headerWord("en")}) (.+?)(?: · (.+))?${CLOSE}$`,
);
const LABEL = /^(.+):(\d+)(?:–(\d+))?$/;

/** `path:from–to`, or `path:from` for one line. */
export function quoteLabel(q: {
  readonly path: string;
  readonly from: number;
  readonly to: number;
}): string {
  return q.to > q.from ? `${q.path}:${q.from}–${q.to}` : `${q.path}:${q.from}`;
}

/** A quote's source held to the bounds, with a note of what was left out. */
export function boundQuoteText(text: string, lang: "zh" | "en"): string {
  const lines = text.split("\n");
  let kept = lines.slice(0, QUOTE_MAX_LINES);
  let body = kept.join("\n");
  if (body.length > QUOTE_MAX_CHARS) {
    body = body.slice(0, QUOTE_MAX_CHARS);
    kept = body.split("\n");
  }
  const left = lines.length - kept.length;
  if (left <= 0 && body.length === text.length) return text;
  const note = makeT(lang)("quote.truncated", { n: Math.max(left, 1) });
  return `${body}\n${note}`;
}

/** A fence of backticks longer than any run inside the text. */
function fenceFor(text: string): string {
  let longest = 0;
  for (const m of text.matchAll(/`+/g))
    longest = Math.max(longest, m[0].length);
  return "`".repeat(Math.max(3, longest + 1));
}

/** One quote as the message carries it. */
export function formatQuote(q: ComposerQuote, lang: "zh" | "en"): string {
  const title =
    q.title !== undefined && q.title.length > 0 ? ` · ${q.title}` : "";
  const fence = fenceFor(q.text);
  return [
    `${OPEN}${headerWord(lang)} ${quoteLabel(q)}${title}${CLOSE}`,
    `${fence}${q.fence ?? ""}`,
    q.text,
    fence,
  ].join("\n");
}

/** The message to send: the quotes first, then what was typed. */
export function composeQuotedMessage(
  quotes: readonly ComposerQuote[],
  typed: string,
  lang: "zh" | "en",
): string {
  if (quotes.length === 0) return typed;
  const head = quotes.map((q) => formatQuote(q, lang)).join("\n\n");
  const rest = typed.trim();
  return rest.length > 0 ? `${head}\n\n${rest}` : head;
}

export interface ParsedQuote {
  readonly label: string;
  readonly path?: string;
  readonly from?: number;
  readonly to?: number;
  readonly title?: string;
  readonly text: string;
}

/**
 * The quotes at the front of a message, and the rest of it. A header that
 * is not followed by a well-formed fence is ordinary text.
 */
export function parseLeadingQuotes(message: string): {
  readonly quotes: readonly ParsedQuote[];
  readonly rest: string;
} {
  const lines = message.split("\n");
  const quotes: ParsedQuote[] = [];
  let i = 0;
  for (;;) {
    const head = HEADER.exec(lines[i] ?? "");
    const open = /^(`{3,})[^`]*$/.exec(lines[i + 1] ?? "");
    if (head === null || open === null) break;
    const fence = open[1] as string;
    const close = lines.findIndex((l, k) => k > i + 1 && l === fence);
    if (close === -1) break;
    const label = head[1] as string;
    const at = LABEL.exec(label);
    quotes.push({
      label,
      ...(at !== null
        ? {
            path: at[1] as string,
            from: Number(at[2]),
            to: Number(at[3] ?? at[2]),
          }
        : {}),
      ...(head[2] !== undefined ? { title: head[2] } : {}),
      text: lines.slice(i + 2, close).join("\n"),
    });
    i = close + 1;
    while ((lines[i] ?? "").trim().length === 0 && i < lines.length) i += 1;
  }
  if (quotes.length === 0) return { quotes, rest: message };
  return { quotes, rest: lines.slice(i).join("\n") };
}

/** A one-line stand-in for a quoted message (the sidebar card's preview):
 *  each quote's label in brackets, then what was said — never the fence.
 *  The stored preview is cut at a fixed length, often inside a fence: a
 *  header whose fence never closes still names its quote, and the cut
 *  source stays out. */
export function quotedMessagePreview(message: string): string {
  const { quotes, rest } = parseLeadingQuotes(message);
  const cut = HEADER.exec(rest.split("\n", 1)[0] ?? "");
  const labels = [
    ...quotes.map((q) => q.label),
    ...(cut !== null ? [cut[1] as string] : []),
  ];
  if (labels.length === 0) return message;
  const head = labels.map((l) => `${OPEN}${l}${CLOSE}`).join("");
  const said = cut === null ? rest.trim() : "";
  return said.length > 0 ? `${head} ${said}` : head;
}
