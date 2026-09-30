import { stripDisplayUnsafe } from "@herta/core/text-sanitize";
import { memo, type RefObject, useEffect, useState } from "react";
import { useT } from "../../i18n/LocaleProvider.js";
import { renderBanzhuanText } from "../../lib/banzhuan-text.js";
import { replyProse } from "../../lib/reply-copy.js";
import { type Segment, segmentSpeech } from "../../lib/segment-speech.js";
import { Tooltip } from "../Tooltip/Tooltip.js";
import { BubbleTime } from "./BubbleTime.js";

/** How long the copy button says "copied" (or "failed") before it reads
 *  "copy" again. */
const COPIED_MS = 1500;

/**
 * Copy the reply (ADR 0072 §3): her prose only — the code cards keep their
 * deliberate lack of a copy affordance (Slice 5 Q1, `replyProse`). Beside
 * the timestamp in the hover-revealed action row, dressed as the user
 * bubble's rewind; it confirms with a check for a moment. A write the
 * platform refuses is said, not swallowed: the button read 已复制 for nothing
 * while main denied the clipboard permission (2026-09-30).
 */
function CopyReply(props: { readonly text: string }): JSX.Element {
  const t = useT();
  const [outcome, setOutcome] = useState<"idle" | "copied" | "failed">("idle");
  useEffect(() => {
    if (outcome === "idle") return;
    const id = window.setTimeout(() => setOutcome("idle"), COPIED_MS);
    return () => window.clearTimeout(id);
  }, [outcome]);
  const label = t(
    outcome === "copied"
      ? "workspace.copied"
      : outcome === "failed"
        ? "workspace.copyFailed"
        : "workspace.copyReply",
  );
  const copied = outcome === "copied";
  return (
    // Portaled: the button sits at the column's LEFT edge (the rewind sits
    // at the right), so an in-flow pill centred on it ran past the
    // scroller's clip and was cut in half (owner 2026-09-29).
    <Tooltip label={label} placement="bottom" portal>
      <button
        type="button"
        className={`message-copy${copied ? " is-copied" : ""}`}
        aria-label={label}
        onClick={() => {
          const write = navigator.clipboard?.writeText(props.text);
          if (write === undefined) {
            setOutcome("failed");
            return;
          }
          void write.then(
            () => setOutcome("copied"),
            () => setOutcome("failed"),
          );
        }}
      >
        <svg
          className="message-copy-svg"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          focusable="false"
        >
          {copied ? (
            <path d="m5 12.5 4.5 4.5L19 7.5" />
          ) : (
            <>
              <rect x="8.5" y="8.5" width="11" height="11" rx="2.5" />
              <path d="M15.5 8.5V6.5a2 2 0 0 0-2-2h-7a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h2" />
            </>
          )}
        </svg>
      </button>
    </Tooltip>
  );
}

export interface HertaBubbleProps {
  readonly text: string;
  /** ISO send time (the block's stamped `at`); the adaptive label is derived
   *  in the BubbleTime leaf, off the shared coarse clock. Omitted for
   *  pre-timestamp blocks → the line is hidden rather than showing a
   *  fabricated time. */
  readonly at?: string;
  /** Conversation language for the 板砖→Brick display alias (default "zh"). */
  readonly lang?: "zh" | "en";
}

/**
 * One segment's body, shared by the committed stack (below) and the live
 * StreamingReply stack. Prose renders inside the speech bubble through the
 * mention/inline-code tokenizer. A fenced-code segment renders OUTSIDE the
 * bubble chrome (user feedback 2026-07-06: code is not speech) — a bare
 * monospace card in the flow, deliberately plain beyond that (no
 * highlighting, no copy affordance: the record is the prompt, and rewarding
 * pasted code would raise its frequency; heavy content belongs in the 板砖
 * evidence lane). Slice 5 Q1.
 *
 * `innerRef` attaches to the outer element of either variant (the rise
 * clone measures it); `caret` renders the composing caret inside the body.
 *
 * memo: the live stack re-renders once per reveal frame, and the
 * incremental segmenter keeps FROZEN segments identity-stable across
 * frames (perf 2026-08-25) — so completed rows bail here and only the
 * growing tail re-tokenizes. Props are otherwise primitives + stable refs.
 */
export const SegmentBody = memo(function SegmentBody(props: {
  readonly seg: Segment | null;
  readonly innerRef?: RefObject<HTMLDivElement>;
  readonly caret?: boolean;
  /** Conversation language, threaded for the 板砖→Brick display alias. Default
   *  "zh" keeps bubbles rendered in isolation (tests) byte-identical. */
  readonly lang?: "zh" | "en";
}): JSX.Element {
  const t = useT();
  const lang = props.lang ?? "zh";
  if (props.seg?.kind === "code") {
    return (
      <div ref={props.innerRef} className="code-standalone">
        {/* Slim header with the fence's lang tag as a slate chip (falls back
            to a localized "code" — the tag itself is canonical fence text,
            the fallback is chrome) — lifts the card from "bare pre" to the
            app's evidence-card language without rewarding the content itself
            (still no highlighting, no copy affordance). */}
        <div className="code-card__head">
          <span className="code-card__lang">
            {props.seg.lang ?? t("workspace.codeChip")}
          </span>
        </div>
        <pre className="code-block">{props.seg.text}</pre>
        {props.caret === true && (
          <span className="streaming-caret" aria-hidden="true" />
        )}
      </div>
    );
  }
  return (
    <div ref={props.innerRef} className="message-bubble herta-bubble">
      <div className="message-text">
        {props.seg !== null &&
          renderBanzhuanText(props.seg.text, "bubble", lang)}
        {props.caret === true && (
          <span className="streaming-caret" aria-hidden="true" />
        )}
      </div>
    </div>
  );
});

/**
 * Herta's finalized reply, rendered as a BUBBLE STACK (slice 5 Q2): the one
 * committed `herta` record block splits on blank-line paragraphs and ```
 * fences into stacked rows — pure presentation over an UNCHANGED record
 * (D7). One utterance keeps ONE action row: the timestamp renders once,
 * under the last row of the stack. A single-paragraph reply produces
 * byte-identical DOM to the pre-stack renderer.
 *
 * memo: props are primitives, and Conversation re-renders per streaming
 * delta — without the bail-out every historical bubble re-segments and
 * re-tokenizes on every delta of an unrelated reply.
 */
export const HertaBubble = memo(function HertaBubble(
  props: HertaBubbleProps,
): JSX.Element | null {
  // stripDisplayUnsafe: render-side scrub for bidi/control chars — covers
  // disk-loaded legacy blocks the commit-side sanitizer (slice 2) never saw.
  // Identity for normal text.
  const safe = stripDisplayUnsafe(props.text);
  const segments = segmentSpeech(safe);
  if (segments.length === 0) return null;
  const prose = replyProse(safe, props.lang ?? "zh");
  const hasActions = prose.length > 0 || props.at !== undefined;
  return (
    <>
      {segments.map((seg, i) => {
        const isLast = i === segments.length - 1;
        return (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: stable positional split of one immutable string
            key={i}
            className={`message-row herta-row${isLast ? "" : " is-stack-mid"}`}
          >
            <SegmentBody seg={seg} lang={props.lang} />
            {/* Hover-revealed action row below the bubble — once per
                utterance, on the stack tail: copy (her prose; ADR 0072 §3)
                and the timestamp. Rewind is a user-turn affordance. */}
            {isLast && hasActions && (
              <div className="message-actions">
                {prose.length > 0 && <CopyReply text={prose} />}
                {props.at !== undefined && <BubbleTime at={props.at} />}
              </div>
            )}
          </div>
        );
      })}
    </>
  );
});
