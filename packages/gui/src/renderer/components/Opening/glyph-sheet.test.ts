import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BASE_LAYER_STYLE,
  DARK_FOREGROUND,
  OPENING_GLYPHS,
  openingGlyphSizes,
  RENDER_OPTIONS,
} from "./ascii-renderer.js";
import {
  openingGlyphSheet,
  releaseOpeningGlyphSheet,
  resetOpeningGlyphSheetForTest,
  startOpeningGlyphSheet,
} from "./glyph-sheet.js";
import type { OpeningSheet } from "./glyph-sheet-layout.js";

/** A stand-in for the sheet worker: records the request, answers when told. */
class FakeWorker {
  readonly posted: unknown[] = [];
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;
  terminated = false;
  postMessage(message: unknown): void {
    this.posted.push(message);
  }
  terminate(): void {
    this.terminated = true;
  }
  answer(data: unknown): void {
    this.onmessage?.({ data } as MessageEvent);
  }
}

function fakeSheet(): { sheet: OpeningSheet; closed: () => number } {
  let closes = 0;
  const bitmap = {
    close: () => {
      closes += 1;
    },
  } as unknown as ImageBitmap;
  return {
    sheet: {
      bitmap,
      dpr: 1,
      ink: BASE_LAYER_STYLE.foreground,
      glyphs: OPENING_GLYPHS,
      entries: [],
      origin: "drawn",
    },
    closed: () => closes,
  };
}

describe("the opening's glyph sheet (M-opening-4)", () => {
  afterEach(() => {
    resetOpeningGlyphSheetForTest();
    delete document.documentElement.dataset.theme;
    vi.useRealTimers();
  });

  it("asks the worker for the loop's sizes at this window, its font, every symbol, the device scale and the ink", () => {
    const worker = new FakeWorker();
    startOpeningGlyphSheet(() => worker as unknown as Worker);
    expect(worker.posted).toEqual([
      {
        sizes: openingGlyphSizes(window.innerWidth, window.innerHeight),
        fontFamily: RENDER_OPTIONS.fontFamily,
        glyphs: OPENING_GLYPHS,
        dpr: window.devicePixelRatio || 1,
        ink: BASE_LAYER_STYLE.foreground,
      },
    ]);
  });

  it("draws in the dark ink when the page is stamped dark before boot", () => {
    document.documentElement.dataset.theme = "dark";
    const worker = new FakeWorker();
    startOpeningGlyphSheet(() => worker as unknown as Worker);
    expect(worker.posted[0]).toMatchObject({ ink: DARK_FOREGROUND });
  });

  it("hands over the sheet, lets the worker finish storing it, and starts only once", async () => {
    vi.useFakeTimers();
    const worker = new FakeWorker();
    startOpeningGlyphSheet(() => worker as unknown as Worker);
    const second = new FakeWorker();
    startOpeningGlyphSheet(() => second as unknown as Worker);
    expect(second.posted).toEqual([]);
    const { sheet } = fakeSheet();
    worker.answer({ type: "sheet", sheet });
    await expect(openingGlyphSheet()).resolves.toBe(sheet);
    // The worker stores the sheet for the next launch after answering, and
    // closes itself; it is only cut off when that never ends.
    expect(worker.terminated).toBe(false);
    vi.advanceTimersByTime(15_000);
    expect(worker.terminated).toBe(true);
  });

  it.each([
    ["no worker can start", () => null],
    [
      "the worker cannot be created",
      () => {
        throw new Error("refused by the CSP");
      },
    ],
  ])("is null when %s", async (_why, spawn) => {
    startOpeningGlyphSheet(spawn);
    await expect(openingGlyphSheet()).resolves.toBeNull();
  });

  it("is null when the worker has no sheet to draw, or fails", async () => {
    const none = new FakeWorker();
    startOpeningGlyphSheet(() => none as unknown as Worker);
    none.answer({ type: "none" });
    await expect(openingGlyphSheet()).resolves.toBeNull();
    resetOpeningGlyphSheetForTest();
    const failing = new FakeWorker();
    startOpeningGlyphSheet(() => failing as unknown as Worker);
    failing.onerror?.(new Event("error"));
    await expect(openingGlyphSheet()).resolves.toBeNull();
    expect(failing.terminated).toBe(true);
  });

  it("is null when never started (the website's landing page, a test)", async () => {
    await expect(openingGlyphSheet()).resolves.toBeNull();
  });

  it("release frees the sheet's pixels, and there is no sheet after it", async () => {
    const worker = new FakeWorker();
    startOpeningGlyphSheet(() => worker as unknown as Worker);
    const { sheet, closed } = fakeSheet();
    worker.answer({ type: "sheet", sheet });
    releaseOpeningGlyphSheet();
    await expect(openingGlyphSheet()).resolves.toBeNull();
    await Promise.resolve();
    expect(closed()).toBe(1);
  });
});
