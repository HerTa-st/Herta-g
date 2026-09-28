import { useEffect, useRef } from "react";
import type { SegmentData } from "./ascii-renderer.js";
import { openingGlyphSheet } from "./glyph-sheet.js";
import type { OpeningSheet } from "./glyph-sheet-layout.js";
import type {
  OpeningDrawEvent,
  OpeningDrawRequest,
} from "./opening-draw.worker.js";
import {
  createOpeningPlayer,
  DISSOLVE_START,
  openingTimeline,
} from "./opening-player.js";

/** How long the draw worker may take to show its first frame after `play`
 *  (while the window is visible) before the main thread plays the opening
 *  instead. A cold start shows it well within this; it only catches a
 *  worker whose frames never come. */
const FIRST_FRAME_WATCHDOG_MS = 2000;

/** How long the opening waits for the glyph sheet once its segment has
 *  loaded (M-opening-4: the owner chose waiting over switching renderers
 *  mid-reveal). A cold start's sheet is drawn in 0.3–0.4 s from boot; this
 *  only bounds a sheet that never comes, after which the loop draws text. */
const SHEET_WAIT_MAX_MS = 2500;

/** The opening's first frame, as `onFirstFrame` reports it. `host` and
 *  `sheet` say how it was drawn; the launch mark carries them, so a CI probe
 *  on another platform can tell the worker path and the glyph sheet ran. */
export interface OpeningFirstFrame {
  /** Epoch ms the draw worker committed it at; absent when it was drawn on
   *  this thread (just now). */
  readonly atEpochMs?: number;
  readonly host: "worker" | "main";
  /** Where the glyphs came from: the sheet (drawn at this launch, or kept
   *  from an earlier one), or text. */
  readonly sheet: "drawn" | "kept" | "none";
}

export interface OpeningAsciiCanvasProps {
  /** The segment to play; null while it loads (the draw worker is already
   *  starting). */
  readonly data: SegmentData | null;
  /** Fired once when the dissolve BEGINS (at DISSOLVE_START), passing the
   *  dissolve duration in ms — the [DISSOLVE_START, DISSOLVE_END] slice of
   *  wall-clock playback — so the overlay's opacity fade-out and the onDone
   *  unmount span the same window the figure dissolves over. */
  readonly onComplete: (dissolveMs: number) => void;
  /** Fired once, when the opening's first frame has been drawn. */
  readonly onFirstFrame?: (frame: OpeningFirstFrame) => void;
  /** Test seam: the draw worker, or null for none. Defaults to the bundled
   *  worker where the platform has one. */
  readonly spawnWorker?: () => Worker | null;
  /** Test seam: the glyph sheet. Defaults to the one boot started drawing
   *  (`glyph-sheet.ts`). */
  readonly getSheet?: () => Promise<OpeningSheet | null>;
}

/** The bundled draw worker, or null where the platform has no `Worker`
 *  (jsdom). Vite emits the worker's entry as a chunk of its own from this
 *  exact expression; the CSP's `worker-src 'self'` admits it. */
function spawnBundledWorker(): Worker | null {
  if (typeof Worker === "undefined") return null;
  return new Worker(new URL("./opening-draw.worker.ts", import.meta.url), {
    type: "module",
  });
}

interface OpeningHost {
  play(data: SegmentData): void;
  dispose(): void;
}

/**
 * Plays a single opening segment once on a canvas. The draw loop
 * (`opening-player.ts`) runs on a worker over the transferred canvas
 * (M-opening-3), so boot work on the main thread and the opening's frames
 * stop waiting on each other; the worker starts as the splash mounts, while
 * the segment still loads. Frames start once the segment has loaded and the
 * glyph sheet boot started is drawn (M-opening-4), so the whole opening
 * draws one way. Where no worker can draw, the same loop runs here
 * on requestAnimationFrame; where there is no 2D context at all (jsdom,
 * headless), a timer completes the sequence.
 *
 * The canvas is created per mount, not rendered: a canvas transferred to a
 * worker can never be drawn or transferred again, and StrictMode's second
 * mount (and the main-thread fallback) each need a fresh one.
 */
export function OpeningAsciiCanvas(
  props: OpeningAsciiCanvasProps,
): JSX.Element {
  const stageRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<OpeningHost | null>(null);
  const onCompleteRef = useRef(props.onComplete);
  onCompleteRef.current = props.onComplete;
  const onFirstFrameRef = useRef(props.onFirstFrame);
  onFirstFrameRef.current = props.onFirstFrame;
  const spawnRef = useRef(props.spawnWorker ?? spawnBundledWorker);
  const sheetRef = useRef(props.getSheet ?? openingGlyphSheet);

  useEffect(() => {
    const stage = stageRef.current;
    if (stage === null) return;
    const host = createOpeningHost(stage, spawnRef.current, sheetRef.current, {
      onComplete: (ms) => onCompleteRef.current(ms),
      onFirstFrame: (frame) => onFirstFrameRef.current?.(frame),
    });
    hostRef.current = host;
    return () => {
      hostRef.current = null;
      host.dispose();
    };
  }, []);

  useEffect(() => {
    if (props.data !== null) hostRef.current?.play(props.data);
  }, [props.data]);

  return <div ref={stageRef} className="opening-ascii-stage" />;
}

function createOpeningHost(
  stage: HTMLDivElement,
  spawnWorker: () => Worker | null,
  getSheet: () => Promise<OpeningSheet | null>,
  events: {
    readonly onComplete: (dissolveMs: number) => void;
    readonly onFirstFrame: (frame: OpeningFirstFrame) => void;
  },
): OpeningHost {
  // Resolved once at mount: the index.html early stamp lands before React.
  const dark = document.documentElement.dataset.theme === "dark";
  let disposed = false;
  let completed = false;
  let firstFrame = false;
  // The segment asked for (plays once), and what plays: the segment with the
  // glyph sheet or null, once the wait for the sheet is over.
  let requested: SegmentData | null = null;
  let ready: {
    readonly segment: SegmentData;
    readonly sheet: OpeningSheet | null;
  } | null = null;
  const complete = (dissolveMs: number): void => {
    if (completed || disposed) return;
    completed = true;
    events.onComplete(dissolveMs);
  };
  // Until the canvas has a frame of its own, the stage is the first frame's
  // opaque veil. The overlay behind it is only 88 % opaque (it frosts the
  // app on purpose once the veil thins), and an empty canvas let the blue
  // app through: the worker's first paint comes ~0.1–0.2 s after the mount
  // (owner 2026-09-25). The veil at playback 0 is this colour, fully opaque.
  stage.style.background = dark ? "rgb(13, 17, 22)" : "rgb(255, 255, 255)";
  const markFirstFrame = (frame: OpeningFirstFrame): void => {
    if (firstFrame || disposed) return;
    firstFrame = true;
    stage.style.background = "";
    events.onFirstFrame(frame);
  };
  const sheetUsed = (used: boolean): OpeningFirstFrame["sheet"] =>
    used && ready?.sheet != null ? ready.sheet.origin : "none";

  let canvas = freshCanvas(stage);
  const viewSize = (): { width: number; height: number; dpr: number } => ({
    width: canvas.clientWidth || window.innerWidth,
    height: canvas.clientHeight || window.innerHeight,
    dpr: window.devicePixelRatio || 1,
  });

  // Teardown of whichever host is playing (the worker, then possibly the
  // main-thread fallback).
  const stops: Array<() => void> = [];
  const stopAll = (): void => {
    for (const stop of stops.splice(0)) stop();
  };

  const playOnMainThread = (
    segment: SegmentData,
    sheet: OpeningSheet | null,
  ): void => {
    let ctx: CanvasRenderingContext2D | null = null;
    try {
      ctx = canvas.getContext("2d");
    } catch {
      ctx = null;
    }
    const timeline = openingTimeline(segment);
    if (ctx === null) {
      const timer = setTimeout(
        () => complete(timeline.dissolveMs),
        Math.ceil(DISSOLVE_START * timeline.wallDurationMs),
      );
      stops.push(() => clearTimeout(timer));
      return;
    }
    const player = createOpeningPlayer(
      canvas,
      ctx,
      segment,
      dark,
      { onDissolve: complete, onInstant: () => complete(0) },
      performance.now(),
      sheet,
    );
    const resize = (): void => {
      const v = viewSize();
      player.resize(v.width, v.height, v.dpr);
    };
    resize();
    window.addEventListener("resize", resize);
    let raf = 0;
    const step = (timeMs: number): void => {
      const more = player.frame(timeMs);
      markFirstFrame({ host: "main", sheet: sheetUsed(player.usesSheet()) });
      if (more) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    stops.push(() => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
    });
  };

  // null: the main thread plays (no worker could start, or it failed).
  let worker: Worker | null = null;
  let watchdog = 0;

  // A worker that cannot draw hands the opening back to this thread, on a
  // fresh canvas (the transferred one is the worker's for good). Once the
  // dissolve has begun there is nothing left to hand back.
  const fallBack = (): void => {
    if (disposed || completed || worker === null) return;
    worker = null;
    stopAll();
    canvas.remove();
    canvas = freshCanvas(stage);
    if (ready !== null) playOnMainThread(ready.segment, ready.sheet);
  };

  const startWorker = (): Worker | null => {
    if (typeof canvas.transferControlToOffscreen !== "function") return null;
    let w: Worker | null;
    try {
      w = spawnWorker();
    } catch {
      return null;
    }
    if (w === null) return null;
    let offscreen: OffscreenCanvas;
    try {
      offscreen = canvas.transferControlToOffscreen();
    } catch {
      w.terminate();
      return null;
    }
    const spawned = w;
    const post = (request: OpeningDrawRequest, transfer: Transferable[] = []) =>
      spawned.postMessage(request, transfer);
    spawned.onmessage = (event: MessageEvent<OpeningDrawEvent>) => {
      const message = event.data;
      if (message.type === "first-frame") {
        markFirstFrame({
          atEpochMs: message.atEpochMs,
          host: "worker",
          sheet: sheetUsed(message.usesSheet),
        });
      } else if (message.type === "dissolve") complete(message.dissolveMs);
      else if (message.type === "instant") complete(0);
      else if (message.type === "no-context") fallBack();
    };
    spawned.onerror = () => fallBack();
    spawned.onmessageerror = () => fallBack();
    const resize = (): void => post({ type: "resize", ...viewSize() });
    window.addEventListener("resize", resize);
    stops.push(() => {
      window.clearTimeout(watchdog);
      window.removeEventListener("resize", resize);
      spawned.onmessage = null;
      spawned.onerror = null;
      spawned.onmessageerror = null;
      spawned.terminate();
    });
    post({ type: "prepare", canvas: offscreen, dark, ...viewSize() }, [
      offscreen,
    ]);
    return spawned;
  };
  worker = startWorker();

  // Frames never coming while the window is visible (a platform where a
  // worker's animation frames do not run) must not leave the splash up.
  const watch = (): void => {
    watchdog = window.setTimeout(() => {
      if (firstFrame || completed || disposed) return;
      if (document.visibilityState === "visible") fallBack();
      else watch();
    }, FIRST_FRAME_WATCHDOG_MS);
  };

  // The sheet, or null once SHEET_WAIT_MAX_MS have passed without one. Until
  // then the canvas holds the first frame's cover (painted at `prepare`).
  const waitForSheet = (): Promise<OpeningSheet | null> =>
    new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), SHEET_WAIT_MAX_MS);
      getSheet().then(
        (sheet) => {
          clearTimeout(timer);
          resolve(sheet);
        },
        () => {
          clearTimeout(timer);
          resolve(null);
        },
      );
    });

  return {
    play(segment) {
      if (disposed || requested !== null) return;
      requested = segment;
      void waitForSheet().then((sheet) => {
        if (disposed) return;
        ready = { segment, sheet };
        if (worker === null) {
          playOnMainThread(segment, sheet);
          return;
        }
        // A clone, not a transfer: the bitmap's pixels are shared, and a
        // fallback to this thread can still use the sheet.
        worker.postMessage({
          type: "play",
          data: segment,
          sheet,
        } satisfies OpeningDrawRequest);
        watch();
      });
    },
    dispose() {
      disposed = true;
      stopAll();
      canvas.remove();
    },
  };
}

function freshCanvas(stage: HTMLDivElement): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.className = "opening-ascii-canvas";
  stage.appendChild(canvas);
  return canvas;
}
