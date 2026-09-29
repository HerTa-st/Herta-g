import { describe, expect, it } from "vitest";
import {
  captureWindowState,
  DEFAULT_WINDOW_H,
  DEFAULT_WINDOW_W,
  fitMinimum,
  MIN_WINDOW_H,
  MIN_WINDOW_W,
  restoreWindowBounds,
} from "./window-state.js";

const PRIMARY = { x: 0, y: 0, width: 2560, height: 1400 };
const LEFT = { x: -1920, y: 0, width: 1920, height: 1040 };
/** A 1366x768 laptop, and 1080p at Windows' recommended 125% scaling — both
 *  SMALLER than the old 1440x900 floor. These are the machines the
 *  pre-2026-08-05 build opened its composer off the edge of. */
const SMALL_LAPTOP = { x: 0, y: 0, width: 1366, height: 728 };
const SCALED_1080P = { x: 0, y: 0, width: 1536, height: 824 };

describe("captureWindowState", () => {
  it("snapshots the NORMAL bounds plus the display mode", () => {
    const snap = captureWindowState({
      getNormalBounds: () => ({ x: 120, y: 60, width: 1600, height: 1000 }),
      isMaximized: () => true,
      isFullScreen: () => false,
    });
    expect(snap).toEqual({
      x: 120,
      y: 60,
      width: 1600,
      height: 1000,
      maximized: true,
      fullScreen: false,
    });
  });
});

describe("MIN_WINDOW_* (the floor)", () => {
  it("stays at 1280x720", () => {
    // Set against a bottom-edge band that turned out to be a stylesheet rule
    // (removed 2026-09-29; app-frame-clip.test.ts). Width is a layout call now;
    // raising it is what put the floor above real laptops (B1).
    expect(MIN_WINDOW_W).toBe(1280);
    expect(MIN_WINDOW_H).toBeLessThanOrEqual(720);
  });

  it("the default footprint is SEPARATE from — and never below — the minimum", () => {
    // These were one number, which is what made the floor unfixable: lowering
    // it to fit a small laptop would have shrunk the window on a 4K monitor.
    expect(DEFAULT_WINDOW_W).toBeGreaterThanOrEqual(MIN_WINDOW_W);
    expect(DEFAULT_WINDOW_H).toBeGreaterThanOrEqual(MIN_WINDOW_H);
  });

  it("fits the minimum to a work area smaller than it (the B1 blocker)", () => {
    // Both fit at the real minimum once it is the measured 1280x720 — which
    // is the point: 1440x900 did NOT fit either of them.
    expect(fitMinimum(SMALL_LAPTOP)).toEqual({ width: 1280, height: 720 });
    expect(fitMinimum(SCALED_1080P)).toEqual({ width: 1280, height: 720 });
    // Roomy displays keep the real minimum.
    expect(fitMinimum(PRIMARY)).toEqual({
      width: MIN_WINDOW_W,
      height: MIN_WINDOW_H,
    });
    // A 1024x768 runner/VM: width yields below the floor on purpose.
    expect(fitMinimum({ x: 0, y: 0, width: 1024, height: 768 })).toEqual({
      width: 1024,
      height: 720,
    });
    expect(fitMinimum(undefined)).toEqual({
      width: MIN_WINDOW_W,
      height: MIN_WINDOW_H,
    });
  });
});

describe("restoreWindowBounds", () => {
  it("falls back to the default footprint with no saved state", () => {
    expect(restoreWindowBounds(undefined, [PRIMARY])).toEqual({
      width: DEFAULT_WINDOW_W,
      height: DEFAULT_WINDOW_H,
      minWidth: MIN_WINDOW_W,
      minHeight: MIN_WINDOW_H,
    });
  });

  // ── B1: first run must FIT the screen it opens on ────────────────────────
  // Pre-fix these returned 1440x900 with a 1440x900 minimum on every display,
  // putting the composer and the Settings button off the desktop with no
  // scroll, no menu, and caption buttons themselves off-screen.
  it("fits the first-run window inside a small laptop's work area", () => {
    const b = restoreWindowBounds(undefined, [SMALL_LAPTOP]);
    expect(b.width).toBeLessThanOrEqual(SMALL_LAPTOP.width);
    expect(b.height).toBeLessThanOrEqual(SMALL_LAPTOP.height);
    // and the floor must not re-impose the oversize
    expect(b.minWidth).toBeLessThanOrEqual(SMALL_LAPTOP.width);
    expect(b.minHeight).toBeLessThanOrEqual(SMALL_LAPTOP.height);
  });

  it("fits the first-run window at 1080p/125% scaling", () => {
    const b = restoreWindowBounds(undefined, [SCALED_1080P]);
    expect(b.width).toBeLessThanOrEqual(SCALED_1080P.width);
    expect(b.height).toBeLessThanOrEqual(SCALED_1080P.height);
    expect(b.minWidth).toBeLessThanOrEqual(SCALED_1080P.width);
    expect(b.minHeight).toBeLessThanOrEqual(SCALED_1080P.height);
  });

  it("caps a size saved on a big monitor when restored on a small one", () => {
    // Unplug the 4K, reopen on the laptop: the saved 2400x1300 must not open
    // larger than the screen either.
    const state = {
      x: 0,
      y: 0,
      width: 2400,
      height: 1300,
      maximized: false,
      fullScreen: false,
    };
    const b = restoreWindowBounds(state, [SMALL_LAPTOP]);
    expect(b.width).toBeLessThanOrEqual(SMALL_LAPTOP.width);
    expect(b.height).toBeLessThanOrEqual(SMALL_LAPTOP.height);
  });

  it("restores an on-screen position and size verbatim", () => {
    const state = {
      x: 200,
      y: 100,
      width: 1800,
      height: 1100,
      maximized: false,
      fullScreen: false,
    };
    expect(restoreWindowBounds(state, [PRIMARY])).toEqual({
      x: 200,
      y: 100,
      width: 1800,
      height: 1100,
      minWidth: MIN_WINDOW_W,
      minHeight: MIN_WINDOW_H,
    });
  });

  it("floors the size at the app minimum", () => {
    const state = {
      x: 10,
      y: 10,
      width: 800,
      height: 500,
      maximized: false,
      fullScreen: false,
    };
    const b = restoreWindowBounds(state, [PRIMARY]);
    expect(b.width).toBe(MIN_WINDOW_W);
    expect(b.height).toBe(MIN_WINDOW_H);
  });

  it("drops a position no longer on any display (unplugged monitor)", () => {
    // Saved on a left-side monitor that is gone now.
    const state = {
      x: -1800,
      y: 50,
      width: 1600,
      height: 1000,
      maximized: false,
      fullScreen: false,
    };
    expect(restoreWindowBounds(state, [PRIMARY])).toEqual({
      width: 1600,
      height: 1000,
      minWidth: MIN_WINDOW_W,
      minHeight: MIN_WINDOW_H,
    });
    // …but keeps it while that monitor is still attached.
    expect(restoreWindowBounds(state, [LEFT, PRIMARY])).toEqual({
      x: -1800,
      y: 50,
      width: 1600,
      height: 1000,
      minWidth: MIN_WINDOW_W,
      minHeight: MIN_WINDOW_H,
    });
  });

  it("drops a position whose title strip sits below the work area", () => {
    const state = {
      x: 100,
      y: 1390, // strip would land under the taskbar edge
      width: 1600,
      height: 1000,
      maximized: false,
      fullScreen: false,
    };
    expect(restoreWindowBounds(state, [PRIMARY])).toEqual({
      width: 1600,
      height: 1000,
      minWidth: MIN_WINDOW_W,
      minHeight: MIN_WINDOW_H,
    });
  });

  it("keeps size-only states positionless", () => {
    const state = {
      width: 1700,
      height: 1000,
      maximized: true,
      fullScreen: false,
    };
    expect(restoreWindowBounds(state, [PRIMARY])).toEqual({
      width: 1700,
      height: 1000,
      minWidth: MIN_WINDOW_W,
      minHeight: MIN_WINDOW_H,
    });
  });

  it("picks the work area the window actually lands on, not just the first", () => {
    // Saved on the LEFT monitor (1920x1040) while PRIMARY is huge: the floor
    // and cap must come from LEFT, so a multi-monitor user with one small
    // screen is not handed the big screen's allowance.
    const state = {
      x: -1900,
      y: 20,
      width: 3000,
      height: 2000,
      maximized: false,
      fullScreen: false,
    };
    const b = restoreWindowBounds(state, [PRIMARY, LEFT]);
    expect(b.width).toBeLessThanOrEqual(LEFT.width);
    expect(b.height).toBeLessThanOrEqual(LEFT.height);
  });
});
