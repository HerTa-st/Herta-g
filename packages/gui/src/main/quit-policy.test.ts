import { CLOSE_SETTLE_CAP_MS } from "@herta/app-server";
import { describe, expect, it } from "vitest";
import {
  QUIT_HOLD_MS,
  quitDisposals,
  quitsWhenAllWindowsClosed,
} from "./quit-policy.js";

describe("QUIT_HOLD_MS (ADR 0071 §1.7)", () => {
  it("outlasts close()'s wait for an interrupted turn to unwind", () => {
    // 3 s against 5 s let a slow unwind lose the turn's ending on a quit.
    expect(QUIT_HOLD_MS).toBeGreaterThan(CLOSE_SETTLE_CAP_MS);
  });
});

describe("quitsWhenAllWindowsClosed", () => {
  it("quits on Windows and Linux whenever the last window closes", () => {
    expect(quitsWhenAllWindowsClosed("win32", false)).toBe(true);
    expect(quitsWhenAllWindowsClosed("linux", false)).toBe(true);
  });

  it("keeps a macOS app in the Dock after an ordinary close…", () => {
    expect(quitsWhenAllWindowsClosed("darwin", false)).toBe(false);
  });

  it("…but quits when a quit is what closed the window — the tray's Exit (2026-09-23)", () => {
    expect(quitsWhenAllWindowsClosed("darwin", true)).toBe(true);
  });
});

describe("quitDisposals", () => {
  const settled = (log: string[], name: string): Promise<void> =>
    new Promise((resolve) =>
      setTimeout(() => {
        log.push(name);
        resolve();
      }, 5),
    );

  it("waits for the live session even when a closed window's dispose is still around (2026-09-23)", async () => {
    // macOS: close (close-to-tray off) → the Dock reopens a window with a new
    // session → Cmd+Q. The stale dispose alone would let the quit through
    // before the live transcript lands.
    const log: string[] = [];
    const stale = Promise.resolve();
    const both = quitDisposals(stale, settled(log, "live"));
    await both;
    expect(log).toEqual(["live"]);
  });

  it("is whichever one exists, or null when there is nothing to wait for", async () => {
    const p = Promise.resolve();
    expect(quitDisposals(p, null)).toBe(p);
    expect(quitDisposals(null, p)).toBe(p);
    expect(quitDisposals(null, null)).toBeNull();
  });
});
