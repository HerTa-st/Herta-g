/**
 * Per-brief store for the backend's own CONCLUSIONS (ADR 0039, 2026-08-17).
 *
 * The report has always carried by-products of a run — files touched, tests,
 * risks, tool receipts — and no place for what the run FOUND.
 * For an analysis brief ("look at this log", "why is the build slow") that
 * was the whole deliverable, and it evaporated: the model's final prose has
 * no channel by design (D6, no Summary field), so 板砖 read the file, said
 * `部分完成`, and Herta had to redo the analysis from whatever head excerpt
 * her prompt happened to hold.
 *
 * A finding is a short claim plus the citations that support it. The tool
 * that records one (`report_finding`) validates the citations against disk
 * before accepting — a conclusion nobody can check is not evidence, and a
 * fabricated `path:line` must fail at the tool, not at Herta.
 */

export interface Finding {
  /** One sentence. Bounded by the tool schema. */
  readonly claim: string;
  /** `path`, `path:line` or `path:from-to`, each verified to exist. */
  readonly cites: readonly string[];
}

/** Findings per brief. A conclusion list, not a transcript: past this the
 *  tool refuses and tells the model to consolidate. */
export const MAX_FINDINGS = 12;

export class FindingsLedger {
  private readonly items: Finding[] = [];

  /** Append; returns the 1-based index, or null when the ledger is full. */
  add(finding: Finding): number | null {
    if (this.items.length >= MAX_FINDINGS) return null;
    this.items.push({ claim: finding.claim, cites: [...finding.cites] });
    return this.items.length;
  }

  all(): readonly Finding[] {
    return this.items.map((f) => ({ claim: f.claim, cites: [...f.cites] }));
  }

  get size(): number {
    return this.items.length;
  }
}
