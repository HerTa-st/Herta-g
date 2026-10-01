import { describe, expect, it } from "vitest";
import {
  ATTACH_PROGRESS_DEFAULTS,
  createAttachProgress,
} from "./attach-progress.js";

const opts = { ...ATTACH_PROGRESS_DEFAULTS, creep: false };

describe("createAttachProgress (2026-10-01)", () => {
  it("shows only once the read outlasts showAfterMs, and never once it is done", () => {
    const p = createAttachProgress(0, opts);
    expect(p.frame(opts.showAfterMs - 1).visible).toBe(false);
    expect(p.frame(opts.showAfterMs).visible).toBe(true);
    p.report({ stage: "done", done: 0, total: 0 }, 900);
    expect(p.frame(1000).visible).toBe(false);
  });

  it("the pages fill their share, the transcripts the rest, and done is full", () => {
    const p = createAttachProgress(0, opts);
    p.report({ stage: "pages", done: 2, total: 4 }, 100);
    expect(p.frame(100).fraction).toBeCloseTo(opts.pagesShare / 2);
    p.report({ stage: "pages", done: 4, total: 4 }, 200);
    expect(p.frame(200).fraction).toBeCloseTo(opts.pagesShare);
    p.report({ stage: "transcripts", done: 5, total: 10 }, 300);
    expect(p.frame(300).fraction).toBeCloseTo(
      opts.pagesShare + (1 - opts.pagesShare) / 2,
    );
    p.report({ stage: "done", done: 0, total: 0 }, 400);
    expect(p.frame(400).fraction).toBe(1);
  });

  it("never goes backwards — a later stage that starts lower keeps the floor", () => {
    const p = createAttachProgress(0, opts);
    p.report({ stage: "pages", done: 4, total: 4 }, 100);
    const before = p.frame(100).fraction;
    // A new file's first report, or any report that maps lower.
    p.report({ stage: "pages", done: 0, total: 4 }, 200);
    expect(p.frame(200).fraction).toBe(before);
  });

  it("creeps toward the next count while a call is in flight, never reaching it", () => {
    const p = createAttachProgress(0, { ...opts, creep: true });
    p.report({ stage: "transcripts", done: 0, total: 4 }, 0);
    const step = (1 - opts.pagesShare) / 4;
    const at0 = p.frame(0).fraction;
    const later = p.frame(opts.expectTranscriptMs).fraction;
    const much = p.frame(opts.expectTranscriptMs * 50).fraction;
    expect(later).toBeGreaterThan(at0);
    expect(much).toBeLessThanOrEqual(at0 + step * opts.creepCap + 1e-9);
    expect(much).toBeLessThan(at0 + step);
  });

  it("a stage with no total (a Word file) holds still instead of guessing", () => {
    const p = createAttachProgress(0, { ...opts, creep: true });
    p.report({ stage: "pages", done: 0, total: 0 }, 0);
    expect(p.frame(10_000).fraction).toBe(0);
  });
});
