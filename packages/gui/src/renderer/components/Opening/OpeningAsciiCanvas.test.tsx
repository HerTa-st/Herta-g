import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BASE_LAYER_STYLE,
  GLYPH_SIZE_STEP_PX,
  OPENING_GLYPHS,
  openingGlyphSizes,
  type SegmentData,
} from "./ascii-renderer.js";
import type { OpeningSheet } from "./glyph-sheet-layout.js";
import { OpeningAsciiCanvas } from "./OpeningAsciiCanvas.js";

function stubSegment(): SegmentData {
  // 1 cell, 2 frames -> duration 2/24 ≈ 0.083s.
  const bytes = new Uint8Array([10, 200]);
  const framesBase64 = btoa(String.fromCharCode(...bytes));
  return {
    type: "adaptive-ascii-video-segment-v1",
    width: 10,
    height: 10,
    fps: 24,
    frameCount: 2,
    activeCount: 1,
    cells: [[5, 5, 6]],
    framesBase64,
  };
}

/** Let the play's wait for the glyph sheet resolve (a resolved promise). */
const settle = (): Promise<void> => act(async () => {});

/** A minimal 2D context (jsdom has none) that records every font set. */
function stubContext() {
  const fonts: string[] = [];
  const ctx = {
    fonts,
    setTransform: vi.fn(),
    clearRect: vi.fn(),
    fillRect: vi.fn(),
    fillText: vi.fn(),
    drawImage: vi.fn(),
    get font(): string {
      return fonts.at(-1) ?? "";
    },
    set font(value: string) {
      fonts.push(value);
    },
    fillStyle: "",
    globalAlpha: 1,
    textAlign: "",
    textBaseline: "",
  };
  const getCtx = vi
    .spyOn(HTMLCanvasElement.prototype, "getContext")
    .mockReturnValue(ctx as unknown as CanvasRenderingContext2D);
  return { ctx, getCtx };
}

/** A controllable rAF queue with explicit timestamps. */
function fakeFrames() {
  let rafCbs: FrameRequestCallback[] = [];
  const raf = vi
    .spyOn(window, "requestAnimationFrame")
    .mockImplementation((cb) => {
      rafCbs.push(cb);
      return rafCbs.length;
    });
  const pump = (t: number): void => {
    const cbs = rafCbs;
    rafCbs = [];
    act(() => {
      for (const cb of cbs) cb(t);
    });
  };
  return { raf, pump };
}

/** A sheet holding every size the stub segment asks for in jsdom's window. */
function stubSheet(over: Partial<OpeningSheet> = {}): OpeningSheet {
  const data = stubSegment();
  const sizes = openingGlyphSizes(window.innerWidth, window.innerHeight, {
    width: data.width,
    height: data.height,
    maxCellSize: 6,
  });
  const pos = Array.from({ length: OPENING_GLYPHS.length * 2 }, (_, i) => i);
  return {
    bitmap: { width: 1, height: 1 } as unknown as ImageBitmap,
    dpr: window.devicePixelRatio || 1,
    ink: BASE_LAYER_STYLE.foreground,
    glyphs: OPENING_GLYPHS,
    entries: sizes.map((px) => ({ px, w: 9, h: 13, pos })),
    origin: "kept",
    ...over,
  };
}

describe("OpeningAsciiCanvas", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("calls onComplete once after the segment duration (jsdom has no 2D ctx)", async () => {
    vi.useFakeTimers();
    const onComplete = vi.fn();
    render(<OpeningAsciiCanvas data={stubSegment()} onComplete={onComplete} />);
    await settle();
    // jsdom canvas getContext('2d') throws/returns null -> timer fallback of
    // ceil(duration*1000) = 84ms.
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it("renders a canvas element", () => {
    vi.useFakeTimers();
    const { container } = render(
      <OpeningAsciiCanvas data={stubSegment()} onComplete={() => {}} />,
    );
    expect(container.querySelector("canvas")).not.toBeNull();
  });

  it("draws every glyph at a GLYPH_SIZE_STEP_PX size (M-opening-2)", async () => {
    const { ctx } = stubContext();
    const { pump } = fakeFrames();
    render(<OpeningAsciiCanvas data={stubSegment()} onComplete={() => {}} />);
    await settle();
    // Reveal 0 on the first frame draws nothing; 40 ms later the dark cell is in.
    pump(1000);
    pump(1040);
    expect(ctx.fillText).toHaveBeenCalled();
    expect(ctx.fonts.length).toBeGreaterThan(0);
    for (const font of ctx.fonts) {
      const px = Number.parseFloat(font);
      expect(px / GLYPH_SIZE_STEP_PX).toBe(Math.round(px / GLYPH_SIZE_STEP_PX));
    }
  });

  it("completes INSTANTLY (0ms dissolve, no paint) when restored after the timeline expired while hidden (2026-07-14)", async () => {
    const { ctx } = stubContext();
    const { pump } = fakeFrames();
    const onComplete = vi.fn();
    render(<OpeningAsciiCanvas data={stubSegment()} onComplete={onComplete} />);
    await settle();
    // First frame starts the timeline and paints the backdrop veil.
    pump(1000);
    expect(ctx.fillRect).toHaveBeenCalled();
    ctx.fillRect.mockClear();
    ctx.fillText.mockClear();
    // The window was minimized: rAF frozen for a minute, timeline expired.
    pump(61_000);
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onComplete).toHaveBeenCalledWith(0); // instant — no dissolve fade
    // The resumed frame never paints (wiped, not drawn).
    expect(ctx.fillRect).not.toHaveBeenCalled();
    expect(ctx.fillText).not.toHaveBeenCalled();
  });
});

describe("OpeningAsciiCanvas with the glyph sheet (M-opening-4)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("copies every glyph from the sheet to a whole device pixel — no text drawn", async () => {
    const { ctx } = stubContext();
    const { pump } = fakeFrames();
    const sheet = stubSheet();
    const onFirstFrame = vi.fn();
    render(
      <OpeningAsciiCanvas
        data={stubSegment()}
        onComplete={() => {}}
        onFirstFrame={onFirstFrame}
        getSheet={() => Promise.resolve(sheet)}
      />,
    );
    await settle();
    pump(1000);
    pump(1040);
    // The first frame says how it was drawn: here, on this thread, from the
    // sheet kept from an earlier launch.
    expect(onFirstFrame).toHaveBeenCalledWith({ host: "main", sheet: "kept" });
    expect(ctx.fillText).not.toHaveBeenCalled();
    expect(ctx.drawImage).toHaveBeenCalled();
    for (const call of ctx.drawImage.mock.calls) {
      expect(call[0]).toBe(sheet.bitmap);
      // Destination: whole device pixels, at the cell's own size.
      expect(Number.isInteger(call[5])).toBe(true);
      expect(Number.isInteger(call[6])).toBe(true);
      expect([call[7], call[8]]).toEqual([9, 13]);
    }
  });

  it.each([
    ["drawn at another device scale", { dpr: 3 }],
    ["drawn in another ink", { ink: "rgba(1, 2, 3, 1)" }],
    ["missing a size this view needs", { entries: [] }],
  ])("draws text when the sheet was %s", async (_why, over) => {
    const { ctx } = stubContext();
    const { pump } = fakeFrames();
    render(
      <OpeningAsciiCanvas
        data={stubSegment()}
        onComplete={() => {}}
        getSheet={() => Promise.resolve(stubSheet(over))}
      />,
    );
    await settle();
    pump(1000);
    pump(1040);
    expect(ctx.drawImage).not.toHaveBeenCalled();
    expect(ctx.fillText).toHaveBeenCalled();
  });

  it("waits for the sheet before the first frame (the owner's choice: no switch mid-reveal)", async () => {
    const { ctx } = stubContext();
    const { raf, pump } = fakeFrames();
    let deliver: (sheet: OpeningSheet | null) => void = () => undefined;
    const sheet = stubSheet();
    render(
      <OpeningAsciiCanvas
        data={stubSegment()}
        onComplete={() => {}}
        getSheet={() => new Promise((resolve) => (deliver = resolve))}
      />,
    );
    await settle();
    expect(raf).not.toHaveBeenCalled();
    deliver(sheet);
    await settle();
    pump(1000);
    pump(1040);
    expect(ctx.drawImage).toHaveBeenCalled();
    expect(ctx.fillText).not.toHaveBeenCalled();
  });

  it("gives up on a sheet that never comes and draws text", async () => {
    vi.useFakeTimers();
    const { ctx } = stubContext();
    const { raf, pump } = fakeFrames();
    render(
      <OpeningAsciiCanvas
        data={stubSegment()}
        onComplete={() => {}}
        getSheet={() => new Promise(() => undefined)}
      />,
    );
    await settle();
    act(() => {
      vi.advanceTimersByTime(2400);
    });
    expect(raf).not.toHaveBeenCalled();
    await act(async () => {
      vi.advanceTimersByTime(200);
    });
    pump(1000);
    pump(1040);
    expect(ctx.fillText).toHaveBeenCalled();
    expect(ctx.drawImage).not.toHaveBeenCalled();
  });
});

/** A stand-in for the draw worker: records what it is sent, and lets the
 *  test speak for it. */
class FakeWorker {
  readonly posted: unknown[] = [];
  readonly transfers: unknown[][] = [];
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;
  terminated = false;
  postMessage(message: unknown, transfer: unknown[] = []): void {
    this.posted.push(message);
    this.transfers.push(transfer);
  }
  terminate(): void {
    this.terminated = true;
  }
  say(data: unknown): void {
    act(() => this.onmessage?.({ data } as MessageEvent));
  }
  fail(): void {
    act(() => this.onerror?.(new Event("error")));
  }
}

describe("OpeningAsciiCanvas on the draw worker (M-opening-3)", () => {
  const offscreen = { width: 0, height: 0 } as unknown as OffscreenCanvas;
  let transferred: HTMLCanvasElement[] = [];

  function setUp(
    initial: SegmentData | null = stubSegment(),
    getSheet: () => Promise<OpeningSheet | null> = () => Promise.resolve(null),
  ) {
    transferred = [];
    Object.defineProperty(
      HTMLCanvasElement.prototype,
      "transferControlToOffscreen",
      {
        configurable: true,
        value(this: HTMLCanvasElement) {
          transferred.push(this);
          return offscreen;
        },
      },
    );
    const getCtx = vi.spyOn(HTMLCanvasElement.prototype, "getContext");
    const worker = new FakeWorker();
    const onComplete = vi.fn();
    const onFirstFrame = vi.fn();
    const spawnWorker = () => worker as unknown as Worker;
    const view = (data: SegmentData | null) => (
      <OpeningAsciiCanvas
        data={data}
        onComplete={onComplete}
        onFirstFrame={onFirstFrame}
        spawnWorker={spawnWorker}
        getSheet={getSheet}
      />
    );
    const { unmount, container, rerender } = render(view(initial));
    const load = (data: SegmentData) => rerender(view(data));
    return {
      worker,
      onComplete,
      onFirstFrame,
      unmount,
      container,
      getCtx,
      load,
    };
  }

  const PREPARE = {
    type: "prepare",
    canvas: offscreen,
    dark: false,
    width: window.innerWidth,
    height: window.innerHeight,
    dpr: window.devicePixelRatio || 1,
  };

  afterEach(() => {
    delete (
      HTMLCanvasElement.prototype as { transferControlToOffscreen?: unknown }
    ).transferControlToOffscreen;
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("hands the worker its canvas, theme and view size while the segment loads, then the segment — the main thread draws nothing", async () => {
    const { worker, container, getCtx, load } = setUp(null);
    expect(transferred).toHaveLength(1);
    expect(container.querySelector("canvas")).toBe(transferred[0]);
    expect(worker.posted).toEqual([PREPARE]);
    expect(worker.transfers[0]).toEqual([offscreen]);
    load(stubSegment());
    await settle();
    expect(worker.posted).toEqual([
      PREPARE,
      { type: "play", data: stubSegment(), sheet: null },
    ]);
    // A re-render with the same segment plays nothing twice.
    load(stubSegment());
    await settle();
    expect(worker.posted).toHaveLength(2);
    expect(getCtx).not.toHaveBeenCalled();
  });

  it("sends the glyph sheet with the segment, once it is drawn, as a clone", async () => {
    const sheet = stubSheet();
    let deliver: (s: OpeningSheet | null) => void = () => undefined;
    const { worker } = setUp(
      stubSegment(),
      () => new Promise((resolve) => (deliver = resolve)),
    );
    await settle();
    expect(worker.posted).toEqual([PREPARE]);
    deliver(sheet);
    await settle();
    expect(worker.posted[1]).toEqual({
      type: "play",
      data: stubSegment(),
      sheet,
    });
    expect(worker.transfers[1]).toEqual([]);
  });

  it("reports a worker's first frame drawn from the sheet with the sheet's origin", async () => {
    const sheet = stubSheet({ origin: "drawn" });
    const { worker, onFirstFrame } = setUp(stubSegment(), () =>
      Promise.resolve(sheet),
    );
    await settle();
    worker.say({ type: "first-frame", atEpochMs: 5, usesSheet: true });
    expect(onFirstFrame).toHaveBeenCalledWith({
      atEpochMs: 5,
      host: "worker",
      sheet: "drawn",
    });
  });

  it("an unmount while the sheet is awaited plays nothing", async () => {
    let deliver: (s: OpeningSheet | null) => void = () => undefined;
    const { worker, unmount } = setUp(
      stubSegment(),
      () => new Promise((resolve) => (deliver = resolve)),
    );
    unmount();
    deliver(stubSheet());
    await settle();
    expect(worker.posted).toEqual([PREPARE]);
  });

  it("keeps the stage the first frame's opaque veil until the worker's first frame (owner 2026-09-25: blue frames)", () => {
    const { worker, container } = setUp();
    const stage = container.querySelector(
      ".opening-ascii-stage",
    ) as HTMLElement;
    expect(stage.style.background).toBe("rgb(255, 255, 255)");
    worker.say({ type: "first-frame", atEpochMs: 1 });
    expect(stage.style.background).toBe("");
  });

  it("passes on the worker's first frame (with its time) and dissolve, once each", () => {
    const { worker, onComplete, onFirstFrame } = setUp();
    worker.say({ type: "first-frame", atEpochMs: 1234.5, usesSheet: false });
    worker.say({ type: "first-frame", atEpochMs: 9999, usesSheet: false });
    expect(onFirstFrame).toHaveBeenCalledTimes(1);
    expect(onFirstFrame).toHaveBeenCalledWith({
      atEpochMs: 1234.5,
      host: "worker",
      sheet: "none",
    });
    worker.say({ type: "dissolve", dissolveMs: 1234 });
    worker.say({ type: "dissolve", dissolveMs: 99 });
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onComplete).toHaveBeenCalledWith(1234);
  });

  it("an instant finish from the worker completes with no dissolve", () => {
    const { worker, onComplete } = setUp();
    worker.say({ type: "instant" });
    expect(onComplete).toHaveBeenCalledWith(0);
  });

  it("follows the window's size", async () => {
    const { worker } = setUp();
    await settle();
    act(() => {
      window.dispatchEvent(new Event("resize"));
    });
    expect(worker.posted[2]).toEqual({
      type: "resize",
      width: window.innerWidth,
      height: window.innerHeight,
      dpr: window.devicePixelRatio || 1,
    });
  });

  it("terminates the worker and removes its canvas on unmount; late messages do nothing", () => {
    const { worker, onComplete, unmount, container } = setUp();
    const onmessage = worker.onmessage;
    unmount();
    expect(worker.terminated).toBe(true);
    expect(container.querySelector("canvas")).toBeNull();
    act(() =>
      onmessage?.({
        data: { type: "dissolve", dissolveMs: 5 },
      } as MessageEvent),
    );
    expect(onComplete).not.toHaveBeenCalled();
  });

  it.each([
    ["the worker errors", (w: FakeWorker) => w.fail()],
    [
      "the canvas gives the worker no 2D context",
      (w: FakeWorker) => w.say({ type: "no-context" }),
    ],
  ])("plays on the main thread, on a fresh canvas, when %s", async (_what, failWith) => {
    const { worker, container, getCtx, onComplete } = setUp();
    await settle();
    getCtx.mockReturnValue(null);
    vi.useFakeTimers();
    failWith(worker);
    expect(worker.terminated).toBe(true);
    const canvas = container.querySelector("canvas");
    expect(canvas).not.toBeNull();
    expect(canvas).not.toBe(transferred[0]);
    expect(getCtx).toHaveBeenCalledTimes(1);
    // No context here either (jsdom): the timer completes the sequence.
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it("a worker that fails while the segment loads leaves the play to the main thread", async () => {
    const { worker, getCtx, load, container } = setUp(null);
    getCtx.mockReturnValue(null);
    worker.fail();
    expect(worker.terminated).toBe(true);
    expect(getCtx).not.toHaveBeenCalled();
    load(stubSegment());
    await settle();
    expect(getCtx).toHaveBeenCalledTimes(1);
    expect(worker.posted).toEqual([PREPARE]);
    expect(container.querySelectorAll("canvas")).toHaveLength(1);
    expect(container.querySelector("canvas")).not.toBe(transferred[0]);
  });

  it("once the dissolve has begun, a worker error hands nothing back", () => {
    const { worker, getCtx, container } = setUp();
    worker.say({ type: "dissolve", dissolveMs: 800 });
    worker.fail();
    expect(getCtx).not.toHaveBeenCalled();
    expect(container.querySelector("canvas")).toBe(transferred[0]);
  });

  it("falls back when no first frame comes while the window is visible — and waits while it is hidden", async () => {
    vi.useFakeTimers();
    const visibility = vi
      .spyOn(document, "visibilityState", "get")
      .mockReturnValue("hidden");
    const { worker, getCtx } = setUp();
    await settle();
    getCtx.mockReturnValue(null);
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(worker.terminated).toBe(false);
    visibility.mockReturnValue("visible");
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(worker.terminated).toBe(true);
    expect(getCtx).toHaveBeenCalledTimes(1);
  });

  it("the watchdog waits for the play: a slow segment load is not a slow worker", async () => {
    vi.useFakeTimers();
    const { worker, load } = setUp(null);
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(worker.terminated).toBe(false);
    load(stubSegment());
    await settle();
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(worker.terminated).toBe(true);
  });

  it("a first frame in time keeps the worker", async () => {
    vi.useFakeTimers();
    const { worker, getCtx } = setUp();
    await settle();
    worker.say({ type: "first-frame", atEpochMs: 1 });
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(worker.terminated).toBe(false);
    expect(getCtx).not.toHaveBeenCalled();
  });
});
