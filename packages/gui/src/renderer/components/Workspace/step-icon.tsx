export type StepIconKey =
  | "read"
  | "write"
  | "run"
  | "search"
  | "save"
  | "diff"
  | "result"
  | "fail"
  | "attach"
  | "dot";

/** Choose an icon from a projected step body. Parses our own leading verb
 *  (stable strings from workflowLabel); unknown input degrades to a dot. */
export function stepIcon(body: string): StepIconKey {
  const t = body.trimStart();
  if (t.startsWith("patch preview")) return "diff";
  if (t.startsWith("↳")) return "result";
  const verb = t.split(/\s+/)[0] ?? "";
  switch (verb) {
    case "Reading":
      return "read";
    case "Writing":
      return "write";
    case "Running":
    // A stop is still a process-lifecycle row; the run glyph is what the
    // background pair (`Running node …` / `Stopping bg-1`) shares.
    case "Stopping":
      return "run";
    case "Inspecting":
    case "Searching":
    // A digest pass (ADR 0043) is the coprocessor looking through a whole
    // document — the search glyph, not a read (it never shows the text).
    case "Digesting":
      return "search";
    case "Saving":
      return "save";
    default:
      return "dot";
  }
}

const PATHS: Record<StepIconKey, JSX.Element> = {
  read: (
    <>
      <path d="M1 7c2-3.6 10-3.6 12 0c-2 3.6-10 3.6-12 0Z" />
      <circle cx="7" cy="7" r="2" />
    </>
  ),
  write: <path d="M3 11l.8-2.6 5.6-5.6 1.8 1.8-5.6 5.6L3 11Z" />,
  run: <path d="M4.5 3l6 4-6 4Z" />,
  search: (
    <>
      <circle cx="6" cy="6" r="3.6" />
      <line x1="8.8" y1="8.8" x2="12" y2="12" />
    </>
  ),
  save: (
    <>
      <path d="M7 2v6.5M4.3 5.8 7 8.5l2.7-2.7" />
      <line x1="2.5" y1="11.5" x2="11.5" y2="11.5" />
    </>
  ),
  diff: (
    <>
      <line x1="7" y1="2.5" x2="7" y2="11.5" />
      <line x1="2.5" y1="7" x2="11.5" y2="7" />
    </>
  ),
  result: <path d="M4 3v4h6M8 5l2 2-2 2" />,
  fail: <path d="M3.5 3.5l7 7M10.5 3.5l-7 7" />,
  // The composer's own paperclip (ADR 0033), so an attachment row and the
  // button that made it share one glyph — including its centring correction.
  // The path's ink sits 0.32 right and 0.83 low of this shared 14×14 box's
  // centre (measured with getBBox); the icons here share one <svg>, so the
  // offset is undone with a transform rather than the viewBox nudge the
  // composer's standalone copy uses. Same result, ~0.95px up-left.
  attach: (
    <g transform="translate(-0.32 -0.83)">
      <path d="M9.5 4.2 5.3 8.4a1.6 1.6 0 0 0 2.3 2.3l4.2-4.2a3 3 0 0 0-4.2-4.2L3.2 6.6a4.3 4.3 0 0 0 6.1 6.1l3.4-3.4" />
    </g>
  ),
  dot: <circle cx="7" cy="7" r="2.2" />,
};

export function StepIcon(props: { kind: StepIconKey }): JSX.Element {
  return (
    <svg
      data-icon={props.kind}
      width="14"
      height="14"
      viewBox="0 0 14 14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {PATHS[props.kind]}
    </svg>
  );
}
