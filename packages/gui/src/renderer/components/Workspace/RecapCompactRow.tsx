import { useEffect, useMemo, useState } from "react";
import { useReducedMotion } from "../../hooks/useReducedMotion.js";
import { makeT } from "../../i18n/LocaleProvider.js";

// Transient in-world status row shown while the long-session recap summarizer
// is running (between the recap.compaction start/end bus events). Reuses the
// GalaxyTravelRow shimmer shell (status-row / status-core / transfer-text
// is-shimmer) but TEXT ONLY — no station/earth transfer icons (per request).
export interface RecapCompactRowProps {
  /** Quiet-hide exit fade — same contract as GalaxyTravelRow's. */
  readonly exiting?: boolean;
  /** The active session's interaction language: an in-world line narrates
   *  the session, so it reads in the session's language, like the pending
   *  activity line (ADR 0019; release review 2026-10-13). */
  readonly lang: "zh" | "en";
}

export function RecapCompactRow(props: RecapCompactRowProps): JSX.Element {
  const t = useMemo(() => makeT(props.lang), [props.lang]);
  const reduced = useReducedMotion();
  const [shown, setShown] = useState(reduced);
  useEffect(() => {
    if (reduced) {
      setShown(true);
      return;
    }
    const id = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(id);
  }, [reduced]);
  return (
    <div
      className={`status-row${shown ? " is-shown" : ""}${
        props.exiting === true ? " is-exiting" : ""
      }`}
    >
      <div className="status-core">
        <span className="transfer-text is-shimmer">
          {t("workspace.recapping")}
        </span>
      </div>
    </div>
  );
}
