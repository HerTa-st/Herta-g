import type { AttachProgress } from "@herta/app-server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAttachProgressRelay } from "./attach-progress-relay.js";

afterEach(() => {
  vi.useRealTimers();
});

const page = (done: number, total = 100, index = 0): AttachProgress => ({
  index,
  stage: "pages",
  done,
  total,
});

describe("createAttachProgressRelay (2026-10-01)", () => {
  it("a burst of page reports becomes one message per interval, and the last one always lands", () => {
    vi.useFakeTimers();
    let clock = 0;
    const sent: AttachProgress[] = [];
    const relay = createAttachProgressRelay((p) => sent.push(p), {
      minIntervalMs: 50,
      now: () => clock,
    });
    for (let d = 0; d <= 60; d += 1) relay.push(page(d));
    // The first passes; the rest are held.
    expect(sent.map((p) => p.done)).toEqual([0]);
    clock = 50;
    vi.advanceTimersByTime(50);
    // The held report is the LATEST, not the first that was held.
    expect(sent.map((p) => p.done)).toEqual([0, 60]);
  });

  it("a stage change, the last page and done pass at once", () => {
    let clock = 0;
    const sent: AttachProgress[] = [];
    const relay = createAttachProgressRelay((p) => sent.push(p), {
      minIntervalMs: 50,
      now: () => clock,
    });
    relay.push(page(0, 3));
    relay.push(page(3, 3));
    relay.push({ index: 0, stage: "transcripts", done: 0, total: 2 });
    relay.push({ index: 0, stage: "done", done: 0, total: 0 });
    expect(sent.map((p) => p.stage)).toEqual([
      "pages",
      "pages",
      "transcripts",
      "done",
    ]);
    relay.flush();
    expect(sent).toHaveLength(4);
    clock = 0;
  });

  it("files are throttled apart, and flush sends what is held", () => {
    vi.useFakeTimers();
    const sent: AttachProgress[] = [];
    const relay = createAttachProgressRelay((p) => sent.push(p), {
      minIntervalMs: 50,
      now: () => 0,
    });
    relay.push(page(0, 10, 0));
    relay.push(page(0, 10, 1));
    relay.push(page(5, 10, 0));
    expect(sent).toHaveLength(2);
    relay.flush();
    expect(sent.at(-1)).toMatchObject({ index: 0, done: 5 });
    vi.advanceTimersByTime(100);
    expect(sent).toHaveLength(3);
  });
});
