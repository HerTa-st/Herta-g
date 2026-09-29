import type { SessionTopic, TerminalRecord } from "@herta/core";

/** Safety cap on the persisted topic history — one entry per genuine title
 *  change (at most one per RETITLE_EVERY_N_TURNS user turns), so even a
 *  marathon session stays far below this. */
export const TOPIC_HISTORY_CAP = 100;

/** Max characters of the anchoring user message kept as the card preview. */
export const TOPIC_ANCHOR_TEXT_MAX = 80;

/** Truncate an anchor message for the topic entry's preview line. */
export function topicAnchorText(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > TOPIC_ANCHOR_TEXT_MAX
    ? `${flat.slice(0, TOPIC_ANCHOR_TEXT_MAX)}…`
    : flat;
}

/**
 * Append a topic for a freshly generated title, or return null when the
 * title did NOT change (the periodic retitle re-derived the same one — the
 * conversation stayed on topic, no boundary). Capped at TOPIC_HISTORY_CAP
 * (oldest dropped).
 */
export function appendTopic(
  topics: readonly SessionTopic[],
  entry: SessionTopic,
): SessionTopic[] | null {
  const last = topics[topics.length - 1];
  if (last !== undefined && last.title === entry.title) return null;
  const next = [...topics, entry];
  return next.length > TOPIC_HISTORY_CAP
    ? next.slice(next.length - TOPIC_HISTORY_CAP)
    : next;
}

/**
 * Drop topics a rewind invalidated. Returns the same reference when nothing
 * changed.
 *
 * TWO ways a topic dies, and the second one is the whole point (user
 * 2026-07-30 — after rewinding the turn that started a new topic, the rail
 * still showed its tick):
 *
 * - Its anchor is gone: the block it jumps to no longer exists.
 * - The turn that CREATED it is gone: `bornAtLength` is the record length the
 *   retitle needed to happen at all, so a record now shorter than that has
 *   withdrawn it. This is not implied by the anchor, because the anchor is the
 *   title WINDOW's first user block — after a re-entry retitle that is a
 *   message from hours ago, which survives the rewind untouched.
 *
 * Topics without `bornAtLength` (pre-2026-07-30 sidecars) are judged on the
 * anchor alone, exactly as before.
 */
export function pruneTopics(
  topics: readonly SessionTopic[],
  recordLength: number,
): readonly SessionTopic[] {
  const alive = (t: SessionTopic): boolean =>
    t.anchorIndex < recordLength &&
    (t.bornAtLength === undefined || t.bornAtLength <= recordLength);
  if (topics.every(alive)) return topics;
  return topics.filter(alive);
}

/**
 * Backfill for sessions titled BEFORE the topic history existed: their
 * sidecar has a title but no topics, so the rail would stay empty until the
 * next retitle. Synthesize the first entry from the existing title, anchored
 * at the record's first user block. In-memory only — it persists with the
 * next real title write. Null when there is nothing to synthesize (no
 * title, no user block, or a history already exists).
 */
export function synthesizeInitialTopic(
  title: string | null,
  topics: readonly SessionTopic[],
  record: TerminalRecord,
): SessionTopic | null {
  if (title === null || topics.length > 0) return null;
  for (let i = 0; i < record.length; i++) {
    const block = record[i];
    if (block?.kind === "user") {
      return {
        title,
        anchorIndex: i,
        anchorText: topicAnchorText(block.text),
        at: block.at ?? new Date().toISOString(),
      };
    }
  }
  return null;
}

/**
 * The topics after the user renames the session (ADR 0072 §3, owner
 * 2026-09-30): a rename names the CURRENT topic, so the last entry takes the
 * name — its anchor, its text and its birth stay, since the topic began
 * where it began. With no entries yet, the first is synthesized from the
 * name, as a reopen would (`record` is the whole record; `[]` leaves that
 * to the reopen).
 */
export function renameCurrentTopic(
  topics: readonly SessionTopic[],
  title: string,
  record: TerminalRecord,
): readonly SessionTopic[] {
  const last = topics[topics.length - 1];
  if (last !== undefined) return [...topics.slice(0, -1), { ...last, title }];
  const first = synthesizeInitialTopic(title, topics, record);
  return first === null ? topics : [first];
}
