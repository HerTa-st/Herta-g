import { type BrowserWindow, Notification, powerSaveBlocker } from "electron";
import type { Locale } from "./app-global-settings.js";
import type {
  AttentionHost,
  AttentionNotice,
  AttentionPrefs,
} from "./attention.js";

/**
 * The Electron half of the attention watcher (ADR 0072 §1): the OS
 * notification, the keep-awake hold, and whether the user is looking at the
 * window. Main-process `Notification` — the renderer's notification
 * permission stays denied (index.ts, the permission request handler).
 */
export function createElectronAttentionHost(deps: {
  readonly win: BrowserWindow;
  readonly prefs: () => AttentionPrefs;
  readonly locale: () => Locale;
}): AttentionHost {
  const { win } = deps;
  // A notification is referenced until it closes: on Windows one that is
  // garbage-collected loses its click handler while still on screen.
  const shown = new Set<Notification>();
  const front = (): void => {
    if (win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  };
  return {
    attended: () =>
      !win.isDestroyed() &&
      win.isVisible() &&
      !win.isMinimized() &&
      win.isFocused(),
    prefs: deps.prefs,
    locale: deps.locale,
    notify: (notice: AttentionNotice) => {
      if (!Notification.isSupported()) return;
      const n = new Notification({ title: notice.title, body: notice.body });
      shown.add(n);
      n.on("click", () => {
        shown.delete(n);
        front();
      });
      n.on("close", () => shown.delete(n));
      n.show();
      // The kind only — the title and body may carry the user's own words.
      // Logged once the platform has it; whether it is shown is the OS's
      // (a denied app, Focus Assist).
      console.log(`[herta] notification: ${notice.kind}`);
    },
    dismiss: () => {
      for (const n of shown) n.close();
      shown.clear();
    },
    holdAwake: () => {
      // Keeps the system from sleeping; the display may still turn off.
      const id = powerSaveBlocker.start("prevent-app-suspension");
      console.log("[herta] keep-awake: on");
      return () => {
        if (powerSaveBlocker.isStarted(id)) powerSaveBlocker.stop(id);
        console.log("[herta] keep-awake: off");
      };
    },
  };
}
