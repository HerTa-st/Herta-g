import { describe, expect, it } from "vitest";
import { rendererPermissionAllowed } from "./renderer-permissions.js";

describe("rendererPermissionAllowed — the renderer's one permission (2026-09-30)", () => {
  it("grants the sanitized clipboard WRITE the copy buttons need, and nothing else", () => {
    expect(rendererPermissionAllowed("clipboard-sanitized-write")).toBe(true);
    for (const denied of [
      "clipboard-read",
      "media",
      "mediaKeySystem",
      "geolocation",
      "notifications",
      "midi",
      "midiSysex",
      "pointerLock",
      "fullscreen",
      "openExternal",
      "usb",
      "serial",
      "hid",
      "idle-detection",
      "display-capture",
      "window-management",
      "",
    ]) {
      expect(rendererPermissionAllowed(denied), denied).toBe(false);
    }
  });
});
