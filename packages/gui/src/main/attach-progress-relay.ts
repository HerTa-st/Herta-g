import type { AttachProgress } from "@herta/app-server";

/**
 * Main's relay for an attach's progress (2026-10-01): the pending row's
 * hairline reads it, and nothing else does. A text-only PDF reports its pages
 * as fast as pdfjs parses them — hundreds within a few milliseconds — and
 * each report is an IPC message, so the relay passes:
 *
 * - every change of file or stage, and every `done`, at once (the row's label
 *   and the end of a file must not wait);
 * - otherwise at most one report per file per `minIntervalMs`, and the LAST
 *   one always: a held report is sent when its interval is up, so the bar
 *   never stops short of where the read actually is.
 */
export interface AttachProgressRelay {
  readonly push: (progress: AttachProgress) => void;
  /** Send what is held now and stop the timers (the attach answered). */
  readonly flush: () => void;
}

export function createAttachProgressRelay(
  send: (progress: AttachProgress) => void,
  opts: {
    readonly minIntervalMs?: number;
    readonly now?: () => number;
  } = {},
): AttachProgressRelay {
  const minIntervalMs = opts.minIntervalMs ?? 50;
  const now = opts.now ?? Date.now;
  const last = new Map<number, { stage: string; at: number }>();
  const held = new Map<number, AttachProgress>();
  const timers = new Map<number, ReturnType<typeof setTimeout>>();

  const sendNow = (p: AttachProgress): void => {
    held.delete(p.index);
    const timer = timers.get(p.index);
    if (timer !== undefined) {
      clearTimeout(timer);
      timers.delete(p.index);
    }
    last.set(p.index, { stage: p.stage, at: now() });
    send(p);
  };

  return {
    push(p) {
      const prev = last.get(p.index);
      const due =
        prev === undefined ||
        prev.stage !== p.stage ||
        p.stage === "done" ||
        (p.total > 0 && p.done >= p.total) ||
        now() - prev.at >= minIntervalMs;
      if (due) {
        sendNow(p);
        return;
      }
      held.set(p.index, p);
      if (!timers.has(p.index)) {
        const wait = Math.max(0, minIntervalMs - (now() - prev.at));
        timers.set(
          p.index,
          setTimeout(() => {
            timers.delete(p.index);
            const h = held.get(p.index);
            if (h !== undefined) sendNow(h);
          }, wait),
        );
      }
    },
    flush() {
      for (const p of [...held.values()]) sendNow(p);
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    },
  };
}
