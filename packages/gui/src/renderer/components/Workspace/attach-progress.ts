/**
 * What the pending row of an attach shows while main reads the file
 * (2026-10-01, owner: "a progress bar in the attached PDF's row"). Attaching
 * waits for a PDF's pictures to be found and transcribed — seconds, sometimes
 * tens of them — and until now the record showed nothing until the end.
 *
 * Main reports two stages per file, in order: the PAGES (text and the picture
 * search run in one loop, page by page) and, when pictures were found and the
 * switch is on, their TRANSCRIPTS (parallel calls, counted as they finish).
 * This module turns those reports and the clock into one frame: whether the
 * row shows yet, how full the bar is, and the counts its label names.
 *
 * Pure and clock-driven, so the gallery and the tests run it on a scripted
 * timeline and the component on `performance.now()`.
 */

export type AttachStage = "waiting" | "pages" | "transcripts" | "done";

/** One report from main about one file. `total` 0 = not known yet. */
export interface AttachProgressReport {
  readonly stage: AttachStage;
  readonly done: number;
  readonly total: number;
}

export interface AttachProgressOptions {
  /** How long a read runs before its row shows: a text file lands in
   *  milliseconds and must not flash a pending row. */
  readonly showAfterMs: number;
  /** Where the pages stage ends on the bar; the transcripts fill the rest.
   *  A document with no transcripts jumps from here to full. */
  readonly pagesShare: number;
  /** Let the bar creep toward the next count while one is in flight, so a
   *  15-second vision call does not look like a stall. Never past the next
   *  count, and never backwards. */
  readonly creep: boolean;
  /** The time one step is expected to take, for the creep: a page is quick,
   *  a transcript is a vision call. */
  readonly expectPageMs: number;
  readonly expectTranscriptMs: number;
  /** How close to the next count the creep may get (0..1 of one step). */
  readonly creepCap: number;
}

export const ATTACH_PROGRESS_DEFAULTS: AttachProgressOptions = {
  showAfterMs: 400,
  pagesShare: 0.3,
  creep: true,
  expectPageMs: 150,
  expectTranscriptMs: 6000,
  creepCap: 0.85,
};

export interface AttachProgressFrame {
  /** Whether the pending row is on screen. */
  readonly visible: boolean;
  readonly stage: AttachStage;
  /** 0..1 — never decreases. */
  readonly fraction: number;
  readonly done: number;
  readonly total: number;
}

export interface AttachProgress {
  report(r: AttachProgressReport, now: number): void;
  frame(now: number): AttachProgressFrame;
}

export function createAttachProgress(
  startedAt: number,
  opts: AttachProgressOptions = ATTACH_PROGRESS_DEFAULTS,
): AttachProgress {
  let last: AttachProgressReport = { stage: "waiting", done: 0, total: 0 };
  let lastAt = startedAt;
  let floor = 0;

  const span = (stage: AttachStage): readonly [number, number] =>
    stage === "pages"
      ? [0, opts.pagesShare]
      : stage === "transcripts"
        ? [opts.pagesShare, 1]
        : stage === "done"
          ? [1, 1]
          : [0, 0];

  return {
    report(r, now) {
      last = r;
      lastAt = now;
    },
    frame(now) {
      const [from, to] = span(last.stage);
      let fraction = from;
      if (last.stage === "done") {
        fraction = 1;
      } else if (last.total > 0) {
        const step = (to - from) / last.total;
        fraction = from + step * Math.min(last.done, last.total);
        if (opts.creep && last.done < last.total) {
          const expect =
            last.stage === "pages"
              ? opts.expectPageMs
              : opts.expectTranscriptMs;
          const t = Math.max(0, now - lastAt) / Math.max(1, expect);
          // An eased approach: quick at first, slowing toward the cap.
          fraction += step * opts.creepCap * (1 - Math.exp(-2 * t));
        }
      }
      floor = Math.max(floor, Math.min(1, fraction));
      return {
        visible: last.stage !== "done" && now - startedAt >= opts.showAfterMs,
        stage: last.stage,
        fraction: floor,
        done: last.done,
        total: last.total,
      };
    },
  };
}
