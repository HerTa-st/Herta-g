import type { TerminalRecord } from "@herta/core";
import { dealiasBrickDraft } from "./banzhuan-mention.js";

/**
 * Up-arrow recall (ADR 0072 §3): the last message the user SENT in this
 * session, for an empty composer. A steer (ADR 0063) and a 继续 (ADR 0071)
 * are not messages the user composed there, so they are passed over; a
 * picture-only message has no text to recall. The record stores the wire
 * token `@板砖`; an EN session's draft gets `@Brick` back, as rewind does.
 * Null when there is nothing to recall.
 */
export function recallLastMessage(
  record: TerminalRecord,
  lang: "zh" | "en",
): string | null {
  for (let i = record.length - 1; i >= 0; i -= 1) {
    const b = record[i];
    if (b?.kind !== "user" || b.steer === true || b.resume === true) continue;
    if (b.text.trim().length === 0) continue;
    return dealiasBrickDraft(b.text, lang);
  }
  return null;
}
