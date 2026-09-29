/**
 * Run-level measurements for the usage log (2026-09-29 long-run study, item
 * 6). The providers' sink (`@herta/providers` usage.ts) records what each
 * model call cost; it cannot say what a call belonged to. Two questions need
 * that, and both are answered here before anything is built on a guess:
 *
 *  - does 板砖's budget trim bite on real runs — how often a run reaches
 *    phase 1 (old tool payloads cleared) or phase 2 (whole old iterations
 *    dropped), and how far past the budget its transcript grows? An LLM
 *    summary of the backend transcript is proposed only if phase 2 matters.
 *  - does Herta's prompt outgrow its budget inside a turn? Her recap
 *    compaction is checked once, at turn start; a turn with chained
 *    dispatches and beats keeps growing after it.
 *
 * Numbers only, like the per-call lines: no prompt text, no session or run
 * identity. Sizes are the harness's own estimates (`estimatePromptTokens`),
 * the unit the budgets are kept in; the API's own counts are on the per-call
 * lines beside them.
 *
 * A process-wide sink, installed by the host with the usage log. Absent (the
 * tests, a lab), nothing is recorded.
 */

/** One 板砖 run: every model call it made, and the trim each one needed. */
export interface BackendRunNote {
  readonly kind: "backend-run";
  /** Model calls the run built a frame for. */
  readonly steps: number;
  /** Calls whose frame had old tool payloads cleared (trim phase 1). */
  readonly clearedSteps: number;
  /** Calls whose frame dropped whole old iterations (trim phase 2). */
  readonly droppedSteps: number;
  /** The most old iterations one frame dropped. */
  readonly maxDropped: number;
  /** The largest frame sent, estimated. */
  readonly peakSent: number;
  /** The largest frame before trimming, estimated: how far past the budget
   *  the run's transcript grew. Equals `peakSent` when nothing was trimmed. */
  readonly peakUntrimmed: number;
  /** The working-set budget the frames were fitted to. */
  readonly budget: number;
}

/** One Herta turn: the completion prompts it sent. */
export interface ActorTurnNote {
  readonly kind: "actor-turn";
  /** Completion calls of the turn (thoughts, speech, beats). */
  readonly calls: number;
  /** The first call's prompt, estimated — about what the turn-start check
   *  sized. */
  readonly firstPrompt: number;
  /** The largest prompt of the turn, estimated. */
  readonly peakPrompt: number;
  /** The recap's high-water mark, when compaction is on: the size the
   *  turn-start check holds the prompt under. */
  readonly highWater?: number;
}

export type UsageNote = BackendRunNote | ActorTurnNote;

export type UsageNoteSink = (note: UsageNote) => void;

let installed: UsageNoteSink | undefined;

/** Install the process-wide note sink. `undefined` removes it. */
export function setUsageNoteSink(sink: UsageNoteSink | undefined): void {
  installed = sink;
}

/** Hand one note to the installed sink. A sink that throws never reaches the
 *  run it measures. */
export function reportUsageNote(note: UsageNote): void {
  if (installed === undefined) return;
  try {
    installed(note);
  } catch {
    // observation must not break the run it observes
  }
}
