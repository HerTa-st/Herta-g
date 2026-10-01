import type { AttachProgressFrame } from "./attach-progress.js";
import { useAttachFrame } from "./pending-attach.js";

/**
 * A placeholder attachment row's progress (2026-10-01, the owner's pick:
 * "Hairline"): the count at the right of the file name, and a thin line
 * under it that fills as main reads the pages and transcribes the pictures.
 * Both read the pending-attach store frame by frame, so the row above them —
 * memoized with the rest of the conversation — never re-renders for it.
 */
export function AttachProgressLabel(props: {
  readonly index: number;
  readonly label: (frame: AttachProgressFrame | undefined) => string;
}): JSX.Element {
  const frame = useAttachFrame(props.index);
  return (
    <span className="activity-step__progress-label">{props.label(frame)}</span>
  );
}

export function AttachProgressBar(props: {
  readonly index: number;
}): JSX.Element {
  const frame = useAttachFrame(props.index);
  const pct = ((frame?.fraction ?? 0) * 100).toFixed(1);
  return (
    <div className="activity-step__progress" aria-hidden="true">
      <div
        className="activity-step__progress-fill"
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

/** The real row that just replaced a placeholder: the full line fades and
 *  folds to nothing, so the row settles at its final height with no jump. */
export function AttachProgressFinish(): JSX.Element {
  return (
    <div className="activity-step__progress is-finishing" aria-hidden="true">
      <div className="activity-step__progress-fill" style={{ width: "100%" }} />
    </div>
  );
}
