import { estimatePromptTokens } from "../text/estimate-prompt-tokens.js";
import type { BackendPromptFrame } from "../types/prompt.js";
import type { Message, ToolMessage } from "../types/transcript.js";
import { toolMessageContent } from "./tool-message-content.js";

/**
 * Backend prompt budget (ADR 0025 slice 2). DeepSeek V4's window is 1M
 * tokens, so this is NOT overflow defense — it is a WORKING-SET ceiling,
 * the same philosophy as the actor's recap retune (2026-07-17): a prompt
 * that large is a cost/latency/attention problem long before it is an
 * overflow problem, and a coding backend drowning in stale tool output
 * makes worse tool calls. Trimming is deterministic and happens on the
 * per-iteration frame COPY only — the durable in-memory transcript stays
 * complete, so nothing is irreversibly lost and every iteration re-derives
 * the projection from the full record.
 */
export interface BackendPromptBudget {
  /** Working-set ceiling for one provider call's whole estimated frame. */
  readonly budgetTokens: number;
  /** Newest N tool payloads kept verbatim when phase-1 clearing engages. */
  readonly keepRecentToolPayloads: number;
  /**
   * How far a trim boundary moves when it moves (ADR 0068 §7). Default
   * `DEFAULT_TRIM_BOUNDARY_STEP`; `1` is the exact boundary — the
   * pre-2026-09-21 behaviour, kept reachable so the churn it caused stays
   * measurable (context-budget.test.ts replays both).
   */
  readonly boundaryStep?: number;
}

/**
 * Trim boundaries move in steps of this many (ADR 0068 §7).
 *
 * The provider caches by exact prefix, and once a brief is over budget it
 * stays over budget — so a boundary that tracks the transcript exactly
 * moves on EVERY iteration and takes the cache with it: the phase-1
 * boundary flipped one payload from verbatim to cleared per tool call (a
 * miss from the 9th-newest payload on, every call), and the phase-2 marker
 * — the FIRST message — carried a count that changed per call (a miss of
 * the whole transcript, every call). Snapped to a multiple of the step, a
 * boundary holds still for `step` tool calls and the frames in between are
 * append-only. The price is a wider window: up to `keep + step − 1`
 * payloads ride verbatim instead of exactly `keep`, and up to `step − 1`
 * more old groups are dropped than strictly needed.
 */
export const DEFAULT_TRIM_BOUNDARY_STEP = 8;

export const DEFAULT_BACKEND_PROMPT_BUDGET: BackendPromptBudget = {
  budgetTokens: 200_000,
  keepRecentToolPayloads: 8,
  boundaryStep: DEFAULT_TRIM_BOUNDARY_STEP,
};

/** The wire text itself (2026-09-03): the estimate sizes exactly what the
 *  translate layer sends, not a hand-kept mirror of it. */
function toolResultText(m: ToolMessage): string {
  return toolMessageContent(m.result);
}

function messageText(m: Message): string {
  if (m.role === "user") return m.text;
  if (m.role === "assistant") {
    const calls = m.toolCalls.length > 0 ? JSON.stringify(m.toolCalls) : "";
    return `${m.text}\n${m.reasoningContent ?? ""}\n${calls}`;
  }
  return toolResultText(m);
}

/**
 * Per-message estimates, memoized on message IDENTITY (2026-09-03).
 *
 * The budget re-derives the projection from the whole transcript on every
 * tool call (the statelessness `fitMessagesToBudget` documents), which
 * meant re-stringifying every tool payload and re-walking every character
 * of an up-to-800K-char transcript per iteration — and, once over budget,
 * once more per dropped group. Transcript messages are never mutated after
 * `TranscriptStore` appends them (the phase-1 clear builds a NEW object),
 * so a message's estimate is a fact about that object: a WeakMap keeps it
 * for the object's lifetime and costs nothing when the transcript is
 * discarded. The contract this leans on is pinned by a test.
 */
const messageTokenCache = new WeakMap<Message, number>();

function messageTokens(m: Message): number {
  const cached = messageTokenCache.get(m);
  if (cached !== undefined) return cached;
  const t = estimatePromptTokens(messageText(m)) + 4;
  messageTokenCache.set(m, t);
  return t;
}

export function estimateMessagesTokens(messages: readonly Message[]): number {
  let t = 0;
  for (const m of messages) t += messageTokens(m);
  return t;
}

type FrameBase = Pick<
  BackendPromptFrame,
  "backendSystem" | "scopedRepoInstructions" | "scopedMemory" | "toolSchemas"
>;

/** The frame's INVARIANT part, memoized on the frame object: the turn
 *  loop builds `baseFrame` once per turn and hands the same object to
 *  every iteration (its L2 fix), so the contract text and the tool
 *  schemas are walked once per turn rather than once per tool call. */
const frameBaseTokenCache = new WeakMap<FrameBase, number>();

function frameStaticTokens(frame: FrameBase): number {
  const cached = frameBaseTokenCache.get(frame);
  if (cached !== undefined) return cached;
  const t =
    estimatePromptTokens(frame.backendSystem) +
    estimatePromptTokens(frame.scopedRepoInstructions) +
    estimatePromptTokens(frame.scopedMemory) +
    estimatePromptTokens(JSON.stringify(frame.toolSchemas));
  frameBaseTokenCache.set(frame, t);
  return t;
}

/** Estimated tokens of everything in the frame EXCEPT `messages`. Only the
 *  state trailer — which changes between iterations — is walked per call. */
export function estimateFrameBaseTokens(
  frame: FrameBase,
  trailingState: string,
): number {
  return frameStaticTokens(frame) + estimatePromptTokens(trailingState);
}

const CLEARED_NOTE =
  "old tool output cleared to fit the context budget — re-run the tool if you need it again";

/** A message's cleared form is a fact about that message: one stub per
 *  transcript object, so the per-identity estimate above is computed once
 *  for it rather than once per iteration for every stub in the frame. */
const clearedStubCache = new WeakMap<ToolMessage, ToolMessage>();

function clearPayload(m: ToolMessage): ToolMessage {
  const cached = clearedStubCache.get(m);
  if (cached !== undefined) return cached;
  const stub: ToolMessage = {
    ...m,
    result: {
      ok: m.result.ok,
      summary: m.result.summary,
      data: { cleared: true, note: CLEARED_NOTE },
      ...(m.result.error !== undefined ? { error: m.result.error } : {}),
    },
  };
  clearedStubCache.set(m, stub);
  return stub;
}

function trimMarker(lang: "zh" | "en", droppedGroups: number): Message {
  return {
    role: "assistant",
    text:
      // The task statement is in the system prompt above; the todo list and
      // the working state the harness keeps trail the transcript, at the
      // end (`BackendPromptFrame.trailingState`). This marker used to call
      // the todo list "above" — wrong since the list first trailed.
      lang === "en"
        ? `(context trimmed: ${droppedGroups} earlier tool iteration(s) removed to fit the budget. The task statement above, and the todo list and working state at the end, remain authoritative.)`
        : `（上下文已裁剪：更早的 ${droppedGroups} 轮工具调用记录已移除。上方的任务说明，以及末尾的任务清单和工作状态，仍然有效。）`,
    toolCalls: [],
    ts: "",
  };
}

export interface FitResult {
  readonly messages: Message[];
  readonly estimatedTokens: number;
  /** Phase 1 engaged: how many old tool payloads were cleared. */
  readonly clearedPayloads: number;
  /** Phase 2 engaged: how many leading groups were dropped. */
  readonly droppedGroups: number;
  /** Even the minimal tail exceeds the budget — caller should fail honestly. */
  readonly overBudget: boolean;
}

/**
 * Split the backend transcript into droppable GROUPS that keep the
 * OpenAI pairing invariant (an assistant message with tool_calls must be
 * followed by its tool replies): each group is one assistant message plus
 * every consecutive tool message after it. Leading orphan messages (never
 * produced today, defensive) form their own group.
 */
function groupMessages(messages: readonly Message[]): Message[][] {
  const groups: Message[][] = [];
  let current: Message[] = [];
  for (const m of messages) {
    if (m.role === "assistant") {
      if (current.length > 0) groups.push(current);
      current = [m];
    } else if (current.length > 0) {
      current.push(m);
    } else {
      groups.push([m]);
    }
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

function isCleared(m: ToolMessage): boolean {
  const data = m.result.data as { cleared?: unknown } | undefined;
  return data !== null && typeof data === "object" && Boolean(data.cleared);
}

/** A copy with the OLDEST `count` tool payloads cleared. */
function clearOldest(
  source: readonly Message[],
  toolIdxs: readonly number[],
  count: number,
): { messages: Message[]; cleared: number } {
  const messages = [...source];
  let cleared = 0;
  for (const i of toolIdxs.slice(0, count)) {
    const m = messages[i];
    if (m === undefined || m.role !== "tool" || isCleared(m)) continue;
    messages[i] = clearPayload(m);
    cleared += 1;
  }
  return { messages, cleared };
}

/**
 * Deterministic two-phase trim to the working-set budget:
 *
 *   Phase 1 — clear OLD tool payloads (keep the newest
 *   `keepRecentToolPayloads` tool messages verbatim; older ones keep
 *   their one-line summary but lose the JSON payload). The summaries
 *   plus the todo list preserve "what have I done" at a fraction of the
 *   cost — the CC microcompact pattern, re-derived.
 *
 *   Phase 2 — drop whole leading groups (assistant + its tool replies),
 *   oldest first, always keeping the final group, and prepend a marker
 *   message saying what was dropped.
 *
 * Both boundaries move in STEPS (`boundaryStep`, ADR 0068 §7), because the
 * provider caches by exact prefix and an over-budget brief stays over
 * budget: a boundary that tracks the transcript exactly moves on every
 * iteration and re-bills everything behind it. The order tried:
 *
 *   1. the frame as it is;
 *   2. payloads cleared up to the STEPPED boundary — the window holds
 *      between `keep` and `keep + step − 1` payloads, and the frames
 *      between two moves are append-only (the regime a long brief lives in);
 *   3. payloads cleared up to the EXACT boundary — tight on room; this
 *      slides per call as the whole phase used to, never worse than before;
 *   4. leading groups dropped behind the stepped clearing, the count
 *      rounded UP to a multiple of the step — head and tail both hold still;
 *   5. the same behind the exact clearing — the last resort that keeps the
 *      old guarantee: whatever fit before 2026-09-21 still fits.
 *
 * Pure function over the copied array; the TranscriptStore is never
 * mutated. Re-runs from scratch every iteration, so the projection is
 * stateless: a boundary is a function of the transcript's length, not of
 * what an earlier iteration decided. Re-running is cheap because the
 * per-message estimates are memoized on identity (above) and a message's
 * cleared stub is one object: each fit test is a sum over cached numbers,
 * not a walk over the transcript's text.
 */
export function fitMessagesToBudget(opts: {
  messages: readonly Message[];
  baseTokens: number;
  budget: BackendPromptBudget;
  lang: "zh" | "en";
}): FitResult {
  const { baseTokens, budget, lang } = opts;
  const step = Math.max(
    1,
    Math.floor(budget.boundaryStep ?? DEFAULT_TRIM_BOUNDARY_STEP),
  );
  const estimate = (messages: readonly Message[]): number =>
    baseTokens + estimateMessagesTokens(messages);
  const done = (
    messages: Message[],
    clearedPayloads: number,
    droppedGroups: number,
  ): FitResult => ({
    messages,
    estimatedTokens: estimate(messages),
    clearedPayloads,
    droppedGroups,
    overBudget: false,
  });

  // 1. As it is.
  const whole = [...opts.messages];
  if (estimate(whole) <= budget.budgetTokens) return done(whole, 0, 0);

  // Phase 1: clear old tool payloads, the newest ones intact.
  const toolIdxs = whole
    .map((m, i) => (m.role === "tool" ? i : -1))
    .filter((i) => i >= 0);
  const clearable = Math.max(
    0,
    toolIdxs.length - budget.keepRecentToolPayloads,
  );
  const steppedCount = Math.floor(clearable / step) * step;
  // 2. The stepped boundary (nothing to try when it clears nothing, or when
  // it IS the exact one).
  const stepped =
    steppedCount > 0 && steppedCount !== clearable
      ? clearOldest(whole, toolIdxs, steppedCount)
      : null;
  if (stepped !== null && estimate(stepped.messages) <= budget.budgetTokens) {
    return done(stepped.messages, stepped.cleared, 0);
  }
  // 3. The exact boundary.
  const exact = clearOldest(whole, toolIdxs, clearable);
  if (estimate(exact.messages) <= budget.budgetTokens) {
    return done(exact.messages, exact.cleared, 0);
  }

  // Phase 2: drop leading groups, always keep the last one.
  // 4 then 5 — behind the stepped clearing first, the exact one last.
  let last: FitResult | null = null;
  for (const cleared of stepped !== null ? [stepped, exact] : [exact]) {
    const groups = groupMessages(cleared.messages);
    const sizes = groups.map((g) => estimateMessagesTokens(g));
    const maxDrop = groups.length - 1;
    const withDropped = (count: number): Message[] => [
      trimMarker(lang, count),
      ...groups.slice(count).flat(),
    ];
    // The fewest groups whose removal fits (the marker's own size varies
    // by a digit, so it is measured per candidate, not assumed).
    let remaining = sizes.reduce((a, b) => a + b, 0);
    let needed = 0;
    let fitsAt = -1;
    while (needed < maxDrop) {
      remaining -= sizes[needed] ?? 0;
      needed += 1;
      const est =
        baseTokens +
        estimateMessagesTokens([trimMarker(lang, needed)]) +
        remaining;
      if (est <= budget.budgetTokens) {
        fitsAt = needed;
        break;
      }
    }
    if (fitsAt === -1) {
      // Even marker + last group is over: remember the closest attempt
      // (a single group has nothing to drop, so nothing to announce).
      const messages = maxDrop > 0 ? withDropped(maxDrop) : cleared.messages;
      last = {
        messages,
        estimatedTokens: estimate(messages),
        clearedPayloads: cleared.cleared,
        droppedGroups: Math.max(0, maxDrop),
        overBudget: true,
      };
      continue;
    }
    // Rounded UP to the step: dropping more always still fits (a longer
    // count could only add a digit to the marker — re-checked, not assumed).
    const rounded = Math.min(Math.ceil(fitsAt / step) * step, maxDrop);
    const messages = withDropped(rounded);
    if (estimate(messages) <= budget.budgetTokens) {
      return done(messages, cleared.cleared, rounded);
    }
    return done(withDropped(fitsAt), cleared.cleared, fitsAt);
  }

  return (
    last ?? {
      messages: exact.messages,
      estimatedTokens: estimate(exact.messages),
      clearedPayloads: exact.cleared,
      droppedGroups: 0,
      overBudget: true,
    }
  );
}
