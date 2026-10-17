import {
  EN_EFFECTIVE_MS_PER_CHAR,
  type FenceRegion,
  fenceRegions,
  holdIndexFor,
  humanizedCharDelay,
  isCjkPacingChar,
  nextRevealEnd,
  type PacingMode,
  pacingDecision,
  revealUnitDelay,
  startupDelayMs,
  TARGET_VISIBLE_MS,
} from "./slow-stream-pacing.js";

/**
 * Shared slow-stream reveal DRIVER (consolidation, arch-audit backlog item
 * 2026-07: "consolidate the duplicated slow-stream reveal state machine").
 *
 * Before this module, the timer/cursor state machine that paces Herta's
 * speech existed three times — `BusActorStreamingSink.slowStreamSpeech`,
 * `BusActorStreamingSink.slowStreamSpeechLive` (both in
 * `packages/app-server/src/bus-streaming-sink.ts`), and the CLI
 * `NarrativeRenderer.runSlowStream` (`packages/cli/src/render/
 * narrative-renderer.ts`) — and had drifted twice (the non-live word branch
 * missed the fastForwarding hold-cap escape; the live path missed fence
 * handling). The pure DECISION functions were already shared
 * (slow-stream-pacing.ts); this module owns the LOOP:
 *
 *   - the growing code-point buffer + cursor (`pushToken` / `finishInput`)
 *   - the setTimeout tick chain, starvation return + re-arm
 *   - verdictPending wiring (resolve/reject both open the gate and restart
 *     the reveal-ceiling anchor)
 *   - the supervised front-gate (backlog threshold + finishInput front-load)
 *   - the fence branch (length-keyed region cache, closed/settled semantics,
 *     atomic emit clamped to the verdict hold)
 *   - the word branch (unit emit, partial-word hold with the CJK exemption,
 *     hold cap WITH the fastForwarding escape)
 *   - the char branch (one code point per emit, humanized cadence)
 *   - pacingDecision ramp/hold, the wall-clock reveal ceiling
 *   - flushTail (interrupt/ceiling), fastForward (paced OK-verdict drain),
 *     cancel (terminal reject; the SINK owns its own retract/erase visuals)
 *
 * The driver is LIVE-shaped. A fixed-text stream is the degenerate call
 * pattern `pushToken(text); finishInput()` — with `inputFinished` true from
 * the first tick, the live-only guards (partial-word hold, fence settled
 * check, ceiling `inputFinished` gate, tail ramp gate) all reduce exactly to
 * the historical non-live semantics.
 *
 * Sinks stay data-in/callback-out: they provide `emitRange` (GUI publishes a
 * bus delta; the CLI writes the chunk and records per-code-point widths for
 * its column-accurate retract), `onBegin`/`onFinish` (begin/end stream
 * discipline), and knobs for the two pinned per-sink differences:
 *
 *   - `completionTick` — the CLI historically finishes on a SEPARATE tick
 *     after the last unit (its tests pin the trailing `\n` arriving one
 *     base-delay later, and the extra `revealUnitDelay` random draw); the
 *     GUI finishes on the emitting tick.
 *   - `fences` — the CLI has never had the slice-5 atomic fence emit; on a
 *     styled TTY each write carries its own ANSI wrap, so enabling it would
 *     change the zh byte stream. It keeps pacing fences like prose.
 *   - `maxRevealMs` — the CLI's supervised reveal has no ceiling (it passes
 *     Infinity); its raw lane takes the desktop's.
 *   - `firstDelayMs` — the CLI's first tick is a humanized delay (consumes
 *     one `random` draw at construction); the GUI's is plain `baseMs`.
 *
 * One deliberate unification (unobservable via timers): the fence branch's
 * verdict-hold cap now carries the same `fastForwarding` escape as the word
 * branch and the live variant (`!fastForwarding && inputFinished &&
 * !verdictResolved`), where the historical non-live branch used bare
 * `verdictResolved ? total : holdIndex`. The two differ only when a tick
 * fires with `fastForwarding && !verdictResolved` — impossible in practice,
 * because fastForward re-arms on a MACROtask while the verdictPending
 * settlement that flips `verdictResolved` is a MICROtask queued before it.
 */
export interface RevealDriverDeps {
  /** Reveal granularity — `cjk` (one code point per unit) or `word`. */
  readonly mode: PacingMode;
  /** Per-code-point base cadence (ms) the humanized delays ride on. */
  readonly baseMs: number;
  /** Random source for jitter (injected for deterministic tests). */
  readonly random: () => number;
  /**
   * Wall-clock reveal ceiling (ms), measured from the first emitted unit and
   * re-anchored when a pending verdict resolves. Past it the tail lands in
   * ONE emit. `Number.POSITIVE_INFINITY` disables (the CLI's supervised
   * reveal).
   */
  readonly maxRevealMs: number;
  /** Atomic ``` fence emission (slice 5). `false` paces fenced code like
   *  prose — the CLI status quo (per-write ANSI styling keeps zh
   *  byte-identical). */
  readonly fences: boolean;
  /**
   * `false` (GUI): finish on the tick that emits the last unit. `true`
   * (CLI): fall through to the normal delay computation and schedule ONE
   * more tick, whose drained check performs the finish — the CLI's pinned
   * "completion tick" that writes the trailing newline one delay later.
   */
  readonly completionTick: boolean;
  /** Delay of the FIRST arm (the startup front-load is added on top).
   *  Defaults to `baseMs`. The CLI passes its humanized first delay. */
  readonly firstDelayMs?: number;
  /** Supervisor gate. Present → the stream is SUPERVISED: front-gated,
   *  ramped and held per pacingDecision until the promise settles (either
   *  way) and the actor's terminal call arrives. Absent → unsupervised:
   *  reveal opens immediately, never ramps, never holds. */
  readonly verdictPending?: Promise<void>;
  /** Emit `chars[start, end)` (already joined as `text`) to the surface.
   *  GUI: one bus delta. CLI: one TTY write + width bookkeeping. */
  emitRange(text: string, start: number, end: number): void;
  /** Called exactly once, before the first emit (deferred-begin). */
  onBegin(): void;
  /** Called exactly once on any completing path (natural drain, flushTail,
   *  ceiling). `begun` = whether `onBegin` fired (the CLI skips its
   *  endHertaStream bookkeeping for a zero-emit stream). NOT called on
   *  cancel — the sink owns its cancel visuals. */
  onFinish(begun: boolean): void;
}

/**
 * Controller returned by {@link createRevealDriver}. The sink wraps this in
 * its public `SlowStreamController` / `LiveSlowStreamController`:
 * `cancel()` is a primitive (stop + reject), NOT the full
 * `cancelAndBackspace` — retract events / erase animations are sink-owned.
 */
export interface RevealDriver {
  /** Resolves when the full buffered text has reached the sink; rejects with
   *  `Error("slow-stream cancelled")` on cancel. A no-op catch is attached,
   *  so a never-awaited rejection is not an unhandled rejection. */
  readonly done: Promise<void>;
  /** Code points emitted so far (the GUI's cancel wrapper checks `> 0` to
   *  decide whether a retract event is needed). */
  readonly cursor: number;
  /** Append a chunk to the growing reveal buffer; re-arms a starved reveal.
   *  No-op after finishInput or a terminal state. */
  pushToken(text: string): void;
  /** No more input: total is final — tail ramp/hold applies; a front-gated
   *  reveal opens with the non-live-style startup front-load. */
  finishInput(): void;
  /** OK-verdict resume: exits the hold/ramp and drains PACED at base cadence
   *  (the verdict must not be audible as a speed change). Awaits `done`. */
  fastForward(): Promise<void>;
  /** Interrupt/ceiling drain: the whole remaining tail in ONE emit, right
   *  now. Marks input finished. Synchronous, idempotent. */
  flushTail(): void;
  /** Terminal cancel: stops the loop and rejects `done`. Returns true iff
   *  THIS call performed the transition (false on repeats — the sink uses
   *  it for idempotency of its retract). Works after natural completion too
   *  (the GUI retracts already-settled text on a late veto). */
  cancel(): boolean;
}

export function createRevealDriver(deps: RevealDriverDeps): RevealDriver {
  const { mode, baseMs, random, maxRevealMs, fences, completionTick } = deps;
  const firstDelayMs = deps.firstDelayMs ?? baseMs;

  const chars: string[] = [];
  let inputFinished = false;
  let cursor = 0;
  let cancelled = false;
  let fastForwarding = false;
  /** First arm uses `firstDelayMs`; every later (re-)arm uses `baseMs`. */
  let armedOnce = false;

  // Front-gate state: unsupervised streams open immediately.
  let revealOpen = deps.verdictPending === undefined;
  // Per-code-point cadence used ONLY to size the CHAR-indexed startup /
  // front-gate math in the units those helpers expect (EN paces by word,
  // not char).
  const startupBase = mode === "word" ? EN_EFFECTIVE_MS_PER_CHAR : baseMs;
  // Backlog (code points) at which the reveal opens: enough that the
  // un-ramped reveal already spans TARGET_VISIBLE_MS. Exactly the boundary
  // where startupDelayMs returns 0, so the threshold path and the
  // finishInput front-load path agree.
  const openThresholdChars = Math.ceil(TARGET_VISIBLE_MS / startupBase);

  let verdictResolved = deps.verdictPending === undefined;
  deps.verdictPending
    ?.then(() => {
      verdictResolved = true;
      // Restart the reveal-ceiling anchor: time spent waiting on the
      // supervisor (hold + ramp) must not count against the ceiling, or a
      // slow verdict would instantly flush the post-verdict paced drain.
      firstEmitAtMs = null;
    })
    .catch(() => {
      verdictResolved = true;
      firstEmitAtMs = null;
    });

  let begun = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  let resolveDone!: () => void;
  let rejectDone!: (e: unknown) => void;
  const done = new Promise<void>((res, rej) => {
    resolveDone = res;
    rejectDone = rej;
  });
  // The actor awaits cancelAndBackspace()/fastForward(), never `done`
  // directly, so the contractual `done` rejection on veto would otherwise be
  // an unhandled rejection. Attach a no-op catch; consumers that DO await
  // `done` still observe the rejection.
  done.catch(() => undefined);

  const ensureBegin = (): void => {
    if (!begun) {
      begun = true;
      deps.onBegin();
    }
  };

  let finished = false;
  const finish = (): void => {
    if (finished) return;
    finished = true;
    deps.onFinish(begun);
    resolveDone();
  };

  // Reveal ceiling (slice 3): wall-clock from the FIRST emitted unit while
  // actively emitting. Checked after the verdict-hold gate, so a pending
  // supervisor is never bypassed; once tripped, the remainder lands in one
  // emit via flushTail. Applies only once `inputFinished` (an open input is
  // bounded by generation speed). Date.now tracks vitest fake timers.
  let firstEmitAtMs: number | null = null;

  // Fence regions over the GROWING buffer, recomputed only when the buffer
  // grew (ticks between pushTokens reuse the cache) — per-tick cost O(1).
  let fencesCache: readonly FenceRegion[] = [];
  let fencesCacheLen = -1;
  const currentFences = (): readonly FenceRegion[] => {
    if (chars.length !== fencesCacheLen) {
      fencesCache = fenceRegions(chars);
      fencesCacheLen = chars.length;
    }
    return fencesCache;
  };

  /** Emit `chars[start, end)` and advance the cursor (anchors the ceiling on
   *  the first emit). */
  const emit = (start: number, end: number): void => {
    if (firstEmitAtMs === null) firstEmitAtMs = Date.now();
    deps.emitRange(chars.slice(start, end).join(""), start, end);
    cursor = end;
  };

  const stop = (): void => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  /** Emit the whole buffered tail in ONE emit and finish. Marks input
   *  finished — used on interrupt (the generator is aborted with us) and
   *  past the reveal ceiling. */
  const flushTail = (): void => {
    if (cancelled || finished) return;
    stop();
    inputFinished = true;
    if (cursor < chars.length) {
      ensureBegin();
      emit(cursor, chars.length);
    }
    finish();
  };

  const tick = (delay: number): void => {
    timer = setTimeout(() => {
      timer = null;
      if (cancelled) return;
      if (cursor >= chars.length) {
        // Buffer drained: finish iff input is done; else hold (starved) and
        // wait for pushToken/finishInput to re-arm. With `completionTick`
        // this is also the CLI's deferred completion tick.
        if (inputFinished) finish();
        return;
      }
      // Tail ramp/hold only once the total length is known. A hold leaves
      // the timer unarmed; only fastForward (OK) or cancel (veto) resumes/
      // ends the stream.
      if (!fastForwarding && inputFinished) {
        const decision = pacingDecision({
          cursor,
          total: chars.length,
          verdictResolved,
          chars,
          mode,
        });
        if (decision.kind === "hold") return;
      }
      // Ceiling check AFTER the hold gate; only with input finished and the
      // verdict gate open (never flush past a pending supervisor).
      if (
        firstEmitAtMs !== null &&
        inputFinished &&
        verdictResolved &&
        Date.now() - firstEmitAtMs > maxRevealMs
      ) {
        flushTail();
        return;
      }
      ensureBegin();
      // Fenced code emits ATOMICALLY (slice 5 Q1): a code block typed at
      // speech cadence reads as agony. A cursor inside a region whose
      // closing fence has ARRIVED (or whose input has finished / is
      // fast-forwarding) emits the region in one delta, clamped to the
      // verdict-hold index so the supervisor gate is never bypassed. A
      // region still awaiting its close HOLDS — code lands as a block,
      // never as a typewriter crawl; pushToken/finishInput re-arms.
      if (fences) {
        const fence = currentFences().find(
          (r) => cursor >= r.start && cursor < r.end,
        );
        if (fence !== undefined) {
          const settled = fence.closed || inputFinished || fastForwarding;
          if (!settled) return; // close not yet arrived — wait for more input
          const fenceHoldCap =
            !fastForwarding && inputFinished && !verdictResolved
              ? holdIndexFor(chars.length, chars, mode)
              : chars.length;
          const end = Math.min(fence.end, fenceHoldCap);
          if (end > cursor) {
            emit(cursor, end);
            if (cursor >= chars.length) {
              if (inputFinished) finish();
              return; // starved mid-generation → pushToken re-arms
            }
            tick(baseMs);
            return;
          }
          // end <= cursor: held at the verdict boundary inside the region —
          // unreachable in practice (the pre-emit pacingDecision above
          // already held), kept as a fall-through mirror of the historical
          // branches.
        }
      }
      // EN word reveal (mode `word`): emit a whole word (or newline / space
      // run / single CJK glyph) per delta, on a word-scaled cadence with
      // ASCII breaths. Clamped to the SAME word-hold boundary pacingDecision
      // uses above. Two live-only guards (both no-ops once inputFinished):
      // (1) while input is still OPEN, a trailing run with no whitespace
      // terminator may be a PARTIAL word — hold it rather than emit half a
      // word (a trailing CJK glyph is complete: each CJK code point is its
      // own reveal unit); (2) the verdict-hold clamp applies ONLY when
      // inputFinished; during open input the reveal runs at 1x.
      if (mode === "word") {
        const holdCap =
          // `fastForwarding` escape (audit 2026-07-16 parity): if fastForward
          // ran before the verdictPending microtask flipped `verdictResolved`,
          // a bare verdict-only cap would hit `end <= cursor → return` with
          // no timer armed and hang the turn.
          !fastForwarding && inputFinished && !verdictResolved
            ? holdIndexFor(chars.length, chars, mode)
            : chars.length;
        const start = cursor;
        const end = Math.min(nextRevealEnd(chars, cursor, mode), holdCap);
        const lastCh = chars[end - 1];
        const unterminated =
          lastCh !== " " &&
          lastCh !== "\t" &&
          lastCh !== "\n" &&
          !isCjkPacingChar(lastCh);
        if (
          end === chars.length &&
          unterminated &&
          !inputFinished &&
          !fastForwarding
        ) {
          return; // trailing partial word — wait for pushToken/finishInput
        }
        if (end <= cursor) return; // at the word-hold boundary — a real hold
        emit(start, end);
        if (cursor >= chars.length && !completionTick) {
          if (inputFinished) finish();
          return; // starved mid-generation → pushToken re-arms
        }
        const wordDelay = revealUnitDelay({
          chars,
          start,
          end,
          mode,
          baseMs,
          random,
        });
        if (fastForwarding || !inputFinished) {
          // 1x post-verdict OR while input still open (backlog builds).
          tick(wordDelay);
          return;
        }
        const wnext = pacingDecision({
          cursor,
          total: chars.length,
          verdictResolved,
          chars,
          mode,
        });
        if (wnext.kind === "hold") return;
        tick(wordDelay * wnext.multiplier);
        return;
      }
      // cjk char branch: one code point per emit at the humanized cadence.
      const ch = chars[cursor];
      if (ch !== undefined) emit(cursor, cursor + 1);
      if (cursor >= chars.length && !completionTick) {
        if (inputFinished) finish();
        return; // starved mid-generation → pushToken re-arms
      }
      const baseDelay = humanizedCharDelay({
        emittedChar: ch ?? "",
        baseMs,
        random,
      });
      if (fastForwarding || !inputFinished) {
        // Post-verdict: same cadence as before — the verdict must not be
        // audible as a speed change. fastForward only exits the hold/ramp.
        tick(baseDelay);
        return;
      }
      const next = pacingDecision({
        cursor,
        total: chars.length,
        verdictResolved,
        chars,
        mode,
      });
      if (next.kind === "hold") return;
      tick(baseDelay * next.multiplier);
    }, delay);
  };

  /** First arm gets `firstDelayMs` (the CLI's humanized first delay); every
   *  later re-arm (starvation, finishInput resume) is plain `baseMs`. */
  const armDelay = (): number => {
    const d = armedOnce ? baseMs : firstDelayMs;
    armedOnce = true;
    return d;
  };
  const armIfIdle = (): void => {
    if (!revealOpen) return; // front-gated: the reveal has not opened yet
    if (timer === null && !cancelled) tick(armDelay());
  };
  /** Open the front gate and arm the first tick after `startupMs` (0 for the
   *  backlog-threshold path; the front-load for the finishInput path).
   *  Idempotent. */
  const openReveal = (startupMs: number): void => {
    if (revealOpen) return;
    revealOpen = true;
    if (timer === null && !cancelled) tick(armDelay() + startupMs);
  };

  return {
    done,
    get cursor(): number {
      return cursor;
    },
    pushToken: (text: string): void => {
      if (cancelled || inputFinished) return;
      for (const ch of text) chars.push(ch);
      if (!revealOpen && chars.length >= openThresholdChars) {
        // Backlog already spans the target reveal — start immediately.
        openReveal(0);
        return;
      }
      armIfIdle();
    },
    finishInput: (): void => {
      if (cancelled) return;
      inputFinished = true;
      if (!revealOpen) {
        // Total known: front-load the short reveal so the supervisor wait
        // sits before the text, not on the almost-finished tail.
        openReveal(
          startupDelayMs({ total: chars.length, baseMs: startupBase }),
        );
        return;
      }
      armIfIdle(); // re-evaluate: drain-at-end → finish, or resume the tail
    },
    fastForward: async (): Promise<void> => {
      if (cancelled) return;
      fastForwarding = true;
      // A verdict landing during the front wait skips the startup
      // remainder — the reveal starts now, at base cadence.
      revealOpen = true;
      armedOnce = true;
      if (cursor < chars.length) {
        // Re-arm (also resumes a hold, whose timer is unarmed) and drain the
        // tail PACED at base cadence — the OK verdict must not be audible as
        // a speed change.
        stop();
        tick(baseMs);
      } else if (inputFinished && timer === null) {
        // Drained + finished but `done` not yet resolved (held exactly at
        // the end).
        finish();
      }
      await done;
    },
    flushTail,
    cancel: (): boolean => {
      if (cancelled) return false;
      stop();
      cancelled = true;
      rejectDone(new Error("slow-stream cancelled"));
      return true;
    },
  };
}
