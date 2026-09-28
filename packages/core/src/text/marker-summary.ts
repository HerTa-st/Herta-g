import type { DoneMarkerSummary } from "../types/terminal-record.js";

/**
 * Localized label fragments for {@link composeMarkerSummary}. The caller
 * (CLI system-localize, GUI marker-summary) owns the WORDING — its locale
 * catalog, singular/plural forms, all-pass vs failed test phrasing — while
 * the composer here owns which segments appear and in what order.
 */
export interface MarkerSummaryLabels {
  /** The localized state word for the marker's state (Done / 完成 / …). */
  readonly stateWord: string;
  /** File-count segment, called only when the run touched ≥1 file. */
  readonly file: (n: number) => string;
  /** Test segment, called only when the run executed ≥1 test. */
  readonly tests: (passed: number, failed: number) => string;
  /** Risk-count segment, called only when the backend flagged ≥1 risk. */
  readonly risk: (n: number) => string;
  /** Added/removed lines, called only when every changed file had a real
   *  per-file diff (see `DoneMarkerSummary.lines`). Omit the label to leave
   *  the segment out entirely — older callers stay unchanged. */
  readonly lines?: (add: number, del: number) => string;
  /** Commit-identity segment (ADR 0049 §4), called only when the run's last
   *  successful commit was detected. Optional — omit to leave it out. */
  readonly commit?: (sha: string) => string;
  /** Push-destination segment (ADR 0049 §4), called only when the run's last
   *  successful push was detected. Optional — omit to leave it out. */
  readonly pushed?: (ref: string) => string;
  /** Abnormal-termination word (run aborted / 运行异常中止) — appended only
   *  on the bridge-failure marker (`aborted: true`). */
  readonly aborted: string;
  /** The app-exit word (app exited unexpectedly / 应用意外退出) — appended
   *  only on the marker a session's next open wrote for a run the app
   *  exited during (`crashed: true`, ADR 0071 §1.2). */
  readonly crashed: string;
}

/**
 * Compose a done-marker roll-up ("Done · 2 files · tests 89/89 · 1 risk")
 * from its structured summary. The segment ORDER, the inclusion rules
 * (state always; files/tests/risks only when present; the abort word only on
 * an aborted run), and the ` · ` separator live HERE — the single source the
 * CLI's EN recomposition (system-localize.ts) and the GUI's t()-driven
 * `composeMarkerSummary` (marker-summary.ts) both delegate to, mirroring the
 * canonical CN `body` the bridge authors (buildDoneMarker). Display-only:
 * the canonical body stays the shared-record text (D7); this recomposition
 * is for localizing renderers reading `markerSummary`.
 */
export function composeMarkerSummary(
  m: DoneMarkerSummary,
  labels: MarkerSummaryLabels,
): string {
  const parts: string[] = [labels.stateWord];
  if (m.fileCount > 0) parts.push(labels.file(m.fileCount));
  // Directly after the file count, which it qualifies.
  if (m.lines !== undefined && labels.lines !== undefined) {
    parts.push(labels.lines(m.lines.add, m.lines.del));
  }
  if (m.tests !== undefined) {
    parts.push(labels.tests(m.tests.passed, m.tests.failed));
  }
  // Git outcome identity (ADR 0049 §4): the commit/push the run landed,
  // after the work segments they conclude and before the risk tally.
  if (m.git?.commit !== undefined && labels.commit !== undefined) {
    parts.push(labels.commit(m.git.commit));
  }
  if (m.git?.pushedRef !== undefined && labels.pushed !== undefined) {
    parts.push(labels.pushed(m.git.pushedRef));
  }
  if (m.riskCount > 0) parts.push(labels.risk(m.riskCount));
  // Abnormal termination (bridge-failure marker): the twin of the canonical
  // 运行异常中止 segment — composed, never fabricated as a risk count.
  if (m.aborted === true) parts.push(labels.aborted);
  if (m.crashed === true) parts.push(labels.crashed);
  return parts.join(" · ");
}
