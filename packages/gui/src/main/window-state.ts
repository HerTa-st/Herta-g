import type { WindowStateSnapshot } from "./app-global-settings.js";

/**
 * Window-geometry persistence helpers (2026-07-13): capture the main
 * window's state for GlobalSettings.windowState and restore it at launch —
 * a user who works maximized/fullscreen gets that back next time. Pure
 * (Electron appears only as structural types), so it unit-tests under
 * plain Node.
 */

export interface RectLike {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * The app's minimum footprint — the size below which the window may not be
 * resized, subject to `fitMinimum` below.
 *
 * The floor was set at 1280 against a band of raw body gradient along the
 * window's bottom edge, MEASURED 2026-08-04 as width-driven (1280x720 clean,
 * 1200x800 and 1100x800 → `.app` 96px short) and blamed on a frameless-window
 * quirk. It was our own stylesheet: a leftover
 * `@media (max-width: 1200px) { .app { height: calc(100vh - 96px) } }`.
 * That rule is gone (2026-09-29), `.app` fills the window at every width, and
 * app-frame-clip.test.ts keeps it that way — so 1280 no longer guards
 * against anything; it is the narrowest width the layout has been reviewed
 * at, the same on both platforms. Per-platform TASTE lives in
 * DEFAULT_WINDOW_*.
 *
 * Do not raise width above 1280 to "be safe": that is what put the floor
 * above real laptop screens (audit 2026-08-05, B1).
 */
export const MIN_WINDOW_W = 1280;
export const MIN_WINDOW_H = 720;

/**
 * The first-run footprint — what a fresh profile opens at, BEFORE the
 * display clamp below. Deliberately larger than the minimum: those used to be
 * the same number, which is what made the floor unfixable (lowering it to fit
 * a small laptop would also have shrunk the window on a 4K monitor). Separate
 * knobs: this one is taste, MIN_WINDOW_* is the floor.
 *
 * macOS keeps 1280x800 — the size actually verified on the CI screenshot pass
 * (run 30921312310) and a comfortable fit inside a 13" Air's ~1440x805.
 */
export const DEFAULT_WINDOW_W = process.platform === "darwin" ? 1280 : 1440;
export const DEFAULT_WINDOW_H = process.platform === "darwin" ? 800 : 900;

/**
 * The minimum, shrunk to fit a work area that is smaller than it.
 *
 * Without this the minimum is a hard floor the user cannot escape: on
 * 1366x768, or 1080p at Windows' own recommended 125% scaling (~1536x824
 * DIP), a 1440x900 floor puts the composer and the Settings button off the
 * desktop — and there is no recovery, because the app has no scrollable
 * viewport (`.app` is fixed/inset:0), the caption buttons are pinned to the
 * WINDOW's right edge (also off-desktop at 1366 wide), and there is no menu
 * bar or accelerator. First-run onboarding is the specific casualty: both
 * routes to entering an API key sit in the cut-off region.
 *
 * Below 1280 wide the layout's narrower breakpoints take over (the utility
 * rail hides under 900); the frame still fills the window.
 */
export function fitMinimum(area: RectLike | undefined): {
  width: number;
  height: number;
} {
  if (area === undefined) return { width: MIN_WINDOW_W, height: MIN_WINDOW_H };
  return {
    width: Math.min(MIN_WINDOW_W, area.width),
    height: Math.min(MIN_WINDOW_H, area.height),
  };
}

/** The work area the window will actually open on: the display it overlaps
 *  most, else the first entry (callers pass the primary display first). */
function areaFor(
  workAreas: readonly RectLike[],
  rect: RectLike | undefined,
): RectLike | undefined {
  if (workAreas.length === 0) return undefined;
  if (rect === undefined) return workAreas[0];
  let best = workAreas[0];
  let bestOverlap = -1;
  for (const a of workAreas) {
    const ox =
      Math.min(rect.x + rect.width, a.x + a.width) - Math.max(rect.x, a.x);
    const oy =
      Math.min(rect.y + rect.height, a.y + a.height) - Math.max(rect.y, a.y);
    const overlap = Math.max(ox, 0) * Math.max(oy, 0);
    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      best = a;
    }
  }
  return best;
}
/** How much horizontal overlap with a display the saved position needs for
 *  the title-drag strip to be reachably on screen. */
const VISIBLE_MARGIN = 100;
/** The reachable strip: the window's top edge (title drag region). */
const TITLE_STRIP_H = 48;

export function captureWindowState(win: {
  getNormalBounds(): RectLike;
  isMaximized(): boolean;
  isFullScreen(): boolean;
}): WindowStateSnapshot {
  // getNormalBounds: the RESTORED geometry even while maximized/fullscreen,
  // so un-maximizing after a restart lands where the user left the window.
  const b = win.getNormalBounds();
  return {
    width: b.width,
    height: b.height,
    x: b.x,
    y: b.y,
    maximized: win.isMaximized(),
    fullScreen: win.isFullScreen(),
  };
}

/**
 * The BrowserWindow constructor bounds for a saved state: size floored at
 * the app minimum; the saved position kept only if the window's title strip
 * still lands usably on SOME display (monitor layouts change between
 * launches — a stale x/y would open the window off-screen with no way to
 * drag it back). No state → the default centered footprint.
 */
export function restoreWindowBounds(
  state: WindowStateSnapshot | undefined,
  workAreas: readonly RectLike[],
): {
  width: number;
  height: number;
  x?: number;
  y?: number;
  minWidth: number;
  minHeight: number;
} {
  // minWidth/minHeight ride in the SAME object as the bounds so createWindow
  // spreads one thing and the two can never disagree — they were separate
  // literals before, and that drift is exactly what left the floor
  // unclamped while the size looked fine.
  if (state === undefined) {
    const area = areaFor(workAreas, undefined);
    const min = fitMinimum(area);
    return {
      width: Math.min(
        Math.max(DEFAULT_WINDOW_W, min.width),
        area?.width ?? DEFAULT_WINDOW_W,
      ),
      height: Math.min(
        Math.max(DEFAULT_WINDOW_H, min.height),
        area?.height ?? DEFAULT_WINDOW_H,
      ),
      minWidth: min.width,
      minHeight: min.height,
    };
  }
  const savedRect =
    state.x === undefined || state.y === undefined
      ? undefined
      : {
          x: state.x,
          y: state.y,
          width: state.width,
          height: state.height,
        };
  const area = areaFor(workAreas, savedRect);
  const min = fitMinimum(area);
  // Clamped at BOTH ends: floored at the (display-fitted) minimum, and capped
  // at the work area — a size saved on a 4K monitor must not open larger than
  // the laptop screen it is restored on.
  const width = Math.min(
    Math.max(min.width, Math.round(state.width)),
    area?.width ?? Number.POSITIVE_INFINITY,
  );
  const height = Math.min(
    Math.max(min.height, Math.round(state.height)),
    area?.height ?? Number.POSITIVE_INFINITY,
  );
  const minWidth = min.width;
  const minHeight = min.height;
  if (state.x === undefined || state.y === undefined) {
    return { width, height, minWidth, minHeight };
  }
  const x = Math.round(state.x);
  const y = Math.round(state.y);
  const reachable = workAreas.some(
    (a) =>
      Math.min(x + width, a.x + a.width) - Math.max(x, a.x) >= VISIBLE_MARGIN &&
      y >= a.y - 8 && // top edge at most slightly above the work area
      y + TITLE_STRIP_H <= a.y + a.height,
  );
  return reachable
    ? { width, height, x, y, minWidth, minHeight }
    : { width, height, minWidth, minHeight };
}
