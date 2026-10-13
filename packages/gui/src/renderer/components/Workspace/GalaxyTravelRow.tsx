import { useEffect, useMemo, useState } from "react";
import earthIcon from "../../assets/earth-icon.png";
import earthIconNight from "../../assets/earth-icon-night.png";
import stationIcon from "../../assets/herta-station-icon.png";
import stationIconNight from "../../assets/herta-station-icon-night.png";
import { useReducedMotion } from "../../hooks/useReducedMotion.js";
import { makeT } from "../../i18n/LocaleProvider.js";

export interface GalaxyTravelRowProps {
  /** Quiet-hide exit fade (user 2026-07-31): keeps `is-shown` so the row
   *  fades in place — `is-exiting` wins the opacity — then Conversation
   *  unmounts it after IN_FLIGHT_EXIT_MS. */
  readonly exiting?: boolean;
  /** The active session's interaction language: an in-world line narrates
   *  the session, so it reads in the session's language, like the pending
   *  activity line (ADR 0019; release review 2026-10-13). */
  readonly lang: "zh" | "en";
}

export function GalaxyTravelRow(props: GalaxyTravelRowProps): JSX.Element {
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
        {/* Day/night icon pairs both stay mounted (CSS display swap keyed on
            data-theme) so a theme flip swaps with no decode flash — same
            pattern as the HRT-001 device render. */}
        <img
          className="transfer-icon transfer-icon--day"
          src={stationIcon}
          alt=""
        />
        <img
          className="transfer-icon transfer-icon--night"
          src={stationIconNight}
          alt=""
        />
        <span className="transfer-text is-shimmer">
          {t("workspace.sending")}
        </span>
        <img
          className="transfer-icon transfer-icon--day"
          src={earthIcon}
          alt=""
        />
        <img
          className="transfer-icon transfer-icon--night"
          src={earthIconNight}
          alt=""
        />
      </div>
    </div>
  );
}
