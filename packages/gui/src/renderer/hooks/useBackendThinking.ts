import { useEffect, useState } from "react";
import { useSessionSelector } from "./useSessionSelector.js";

/**
 * How long 板砖 must stay quiet between steps before the working row says
 * it is thinking (owner 2026-10-12: "if its thinking time exceeds N
 * seconds"). Long enough that a quick hand-off between two steps never
 * flickers; short enough that a real thinking stretch shows almost at once.
 */
export const THINKING_AFTER_MS = 3_000;

/** Whether 板砖 has been quiet for `THINKING_AFTER_MS` at `now`. Pure. */
export function isBackendThinking(
  active: boolean,
  quietSince: number | undefined,
  now: number,
): boolean {
  return (
    active && quietSince !== undefined && now - quietSince >= THINKING_AFTER_MS
  );
}

/**
 * 板砖 is thinking: its run is live, every call it made has finished, and
 * its model has not begun the next one for `THINKING_AFTER_MS` (main's
 * `quietSince`, live-tool-feed.ts). Without this the working row kept
 * showing the last step — 「运行 npm test」 shimmering — as if the command
 * were still running while the model thought. Screen-only: nothing of it
 * reaches the record or Herta (D7).
 */
export function useBackendThinking(): boolean {
  const active = useSessionSelector((s) => s.backendActive);
  const quietSince = useSessionSelector((s) => s.live.quietSince);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active || quietSince === undefined) return undefined;
    const wait = quietSince + THINKING_AFTER_MS - Date.now();
    if (wait <= 0) {
      setNow(Date.now());
      return undefined;
    }
    const id = window.setTimeout(() => setNow(Date.now()), wait);
    return () => window.clearTimeout(id);
  }, [active, quietSince]);
  return isBackendThinking(active, quietSince, now);
}
