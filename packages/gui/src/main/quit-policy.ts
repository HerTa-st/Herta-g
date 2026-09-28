import { CLOSE_SETTLE_CAP_MS } from "@herta/app-server";

/**
 * The two quit decisions `main/index.ts` makes, as pure functions (platform
 * review 2026-09-23 — both were wrong on macOS, and index.ts is not
 * unit-testable glue), and how long a quit holds.
 */

/**
 * How long `before-quit` holds exit for the session's flush (ADR 0071
 * §1.7). It ends as soon as every flush settles; this is only its ceiling,
 * and it must outlast `close()`'s own wait for an interrupted turn to unwind
 * plus the persist after it — it was 3 s against that 5 s, so a slow unwind
 * lost the turn's ending on a plain quit.
 */
export const QUIT_HOLD_MS = CLOSE_SETTLE_CAP_MS + 1_500;

/**
 * Whether the app ends when its last window has closed.
 *
 * Everywhere but macOS: yes. On macOS an app conventionally stays in the Dock
 * with no window — UNLESS a quit is what closed that window. The tray's Exit
 * item quits by closing the window first (its orderly-teardown route) and
 * relied on this event to finish the job; on darwin it never did, so Exit
 * left the app running in the Dock with `quitRequested` stuck on, which then
 * broke close-to-tray and crash recovery for the rest of the run.
 */
export function quitsWhenAllWindowsClosed(
  platform: NodeJS.Platform,
  quitRequested: boolean,
): boolean {
  return platform !== "darwin" || quitRequested;
}

/**
 * What a quit waits for: the dispose a closed window already started AND the
 * live session's. The first cut disposed the live session only when nothing
 * was pending — but on macOS a window closed with close-to-tray off leaves
 * its (long settled) dispose behind, the Dock reopens a window with a NEW
 * session, and Cmd+Q then waited on the stale promise while the live
 * session's transcript was cut off mid-turn. Disposing twice is harmless
 * (`dispose` is idempotent); skipping the live one is not.
 */
export function quitDisposals(
  pending: Promise<void> | null,
  live: Promise<void> | null,
): Promise<void> | null {
  if (pending === null) return live;
  if (live === null) return pending;
  return Promise.all([pending, live]).then(() => undefined);
}
