/**
 * Recap boundary-selection fuzz (2026-07-09). The compaction boundary is the
 * seam between the summarized head and the verbatim tail of the record — and
 * the record IS the prompt. A boundary that points at a non-user block, or out
 * of range, silently empties the verbatim window (dropping even the fresh user
 * message) or splits an exchange mid-turn. Both the reopen filter and the recap
 * runtime validate a cached boundary the SAME way — discard unless
 * `0 <= i < record.length && record[i].kind === "user"` — on the stated
 * contract that `selectBoundary` only ever PRODUCES such indices. The point-wise
 * recap tests each pin one boundary scenario; this sweep enumerates the
 * permutation space (record shape × block kinds × text sizes × config budgets)
 * and asserts the invariants that must hold for every combination.
 *
 * Invariants:
 *   R1. Boundary validity: selectBoundary(record, cfg) is 0 (no compaction) OR
 *       an index i with 0 < i < record.length AND record[i].kind === "user".
 *       Never an index into a non-user block, never out of range — validated
 *       exactly as the reopen filter / recap runtime discard a stale cache.
 *   R2. No crash on pathological records: empty, all-user, no-user, a single
 *       enormous block, thousands of tiny blocks — never throws (selectBoundary,
 *       recordSpanTokens, tailWithinTokenBudget).
 *   R3. Tail budget: when a boundary is chosen (b > 0) the verbatim tail
 *       record[b:] keeps >= max(1, minRecentTurns) user turns, and once it
 *       keeps MORE than that floor its token estimate stays <= maxRecentWindow-
 *       Tokens. (The floor of max(1, minRecentTurns) turns is the ONLY thing
 *       that can push the tail past the "hard cap" — asserting the cap
 *       unconditionally would over-reach, since the code keeps the newest
 *       floor turns regardless of size.)
 *   R4. Determinism: repeated calls on the same (record, cfg) agree; so does
 *       estimatePromptTokens on the same text.
 *   R5. estimatePromptTokens / recordSpanTokens algebra: non-negative integers,
 *       empty -> 0, monotone under append/prepend (estimator), exactly additive
 *       across a split point (span sum), monotone in the end bound, and robust
 *       to out-of-range indices (CJK + ASCII + empty text all handled).
 */
import type { TerminalRecord, TerminalRecordBlock } from "@herta/core";
import { describe, expect, it } from "vitest";
import {
  type StaticHertaPrefix,
  serializeActorPrompt,
} from "./actor-prompt.js";
import {
  type CompactionConfig,
  compactThreshold,
  DEFAULT_COMPACTION_CONFIG,
  estimatePromptTokens,
  recordSpanTokens,
  selectBoundary,
  tailWithinTokenBudget,
} from "./session-recap.js";

// Deterministic PRNG (no Math.random — reproducible failures).
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Text atoms spanning empty, ASCII (short/long), full-width punctuation, CJK
// prose, mixed scripts, and whitespace — so a concatenated block ranges from
// zero tokens to (after the occasional repeat below) well past a small budget.
const TEXT_ATOMS = [
  "",
  "a",
  "hello world ",
  "The quick brown fox jumps over the lazy dog. ",
  "黑塔",
  "我在这里做一点实验，观察结果。",
  "，。！？（）",
  "混合 mixed 文本 text 123 ",
  "　\n 　",
  "@板砖 跑一下",
] as const;

function randText(rng: () => number, maxAtoms: number): string {
  const n = Math.floor(rng() * maxAtoms);
  let s = "";
  for (let i = 0; i < n; i++)
    s += TEXT_ATOMS[Math.floor(rng() * TEXT_ATOMS.length)];
  // ~15% of blocks become "large" so token estimates cross small budgets.
  if (rng() < 0.15) s = s.repeat(1 + Math.floor(rng() * 40));
  return s;
}

function randBlock(rng: () => number): TerminalRecordBlock {
  const r = rng();
  const text = randText(rng, 6);
  if (r < 0.35) return { kind: "user", text };
  if (r < 0.55) return { kind: "herta", surface: "speech", text };
  if (r < 0.75) return { kind: "herta", surface: "thought", text };
  const label = rng() < 0.5 ? "系统" : "差分协处理器";
  if (rng() < 0.3) {
    return {
      kind: "system",
      label,
      body: text,
      evidenceDetail: randText(rng, 4),
    };
  }
  return { kind: "system", label, body: text };
}

function randRecord(rng: () => number, maxBlocks: number): TerminalRecord {
  const n = Math.floor(rng() * maxBlocks);
  const blocks: TerminalRecordBlock[] = [];
  for (let i = 0; i < n; i++) blocks.push(randBlock(rng));
  return blocks;
}

const RECENT = [0, 1, 5, 20, 80] as const;
const MAXWIN = [5, 20, 80, 300] as const;
const MINTURNS = [0, 1, 2, 4] as const;

function randCfg(rng: () => number): CompactionConfig {
  // Small budgets (vs the 1M-token defaults) so records of a few dozen blocks
  // straddle the thresholds. maxRecentWindowTokens is deliberately allowed to
  // sit below recentWindowTokens on some draws — the boundary contract must not
  // depend on their ordering.
  return {
    ...DEFAULT_COMPACTION_CONFIG,
    recentWindowTokens: RECENT[Math.floor(rng() * RECENT.length)] ?? 0,
    maxRecentWindowTokens: MAXWIN[Math.floor(rng() * MAXWIN.length)] ?? 5,
    minRecentTurns: MINTURNS[Math.floor(rng() * MINTURNS.length)] ?? 0,
  };
}

/** R1 + R3 for a single (record, cfg). Returns the chosen boundary. */
function checkBoundary(
  label: string,
  record: TerminalRecord,
  cfg: CompactionConfig,
): number {
  let b = 0;
  expect(() => {
    b = selectBoundary(record, cfg);
  }, `${label} :: selectBoundary threw`).not.toThrow();

  // R1 — validity, framed exactly as the reopen filter / recap runtime accept a
  // cached boundary (discard unless in range AND points at a user block).
  if (b === 0) {
    // "no compaction" sentinel — always legal.
  } else {
    expect(
      b > 0 && b < record.length,
      `${label} :: boundary ${b} out of range (len ${record.length})`,
    ).toBe(true);
    expect(
      record[b]?.kind,
      `${label} :: boundary ${b} does not point at a user block`,
    ).toBe("user");

    // R3 — tail budget. The verbatim tail is record[b:].
    const tailTokens = recordSpanTokens(record, b, record.length);
    let keptTurns = 0;
    for (let i = b; i < record.length; i++) {
      if (record[i]?.kind === "user") keptTurns++;
    }
    // The effective floor is Math.max(1, minRecentTurns): selectBoundary keeps
    // at least 1 turn even at minRecentTurns=0 (the floor-of-1 fix, 2026-07-09),
    // since the boundary must point at a user block. A boundary > 0 is only
    // reached after keeping >= that many turns.
    const floor = Math.max(1, cfg.minRecentTurns);
    expect(
      keptTurns >= floor,
      `${label} :: tail keeps ${keptTurns} turns < floor ${floor} (minRecentTurns ${cfg.minRecentTurns})`,
    ).toBe(true);
    // Once the tail keeps MORE than the floor, the newest-added turn was guarded
    // by the hard cap, so the whole tail fits under it. AT the floor the newest
    // turn is kept unconditionally and may exceed the cap.
    if (keptTurns > floor) {
      expect(
        tailTokens <= cfg.maxRecentWindowTokens,
        `${label} :: tail ${tailTokens} tok > maxRecentWindowTokens ${cfg.maxRecentWindowTokens} with ${keptTurns} turns`,
      ).toBe(true);
    }
  }
  return b;
}

describe("recap selectBoundary — validity & tail-budget fuzz", () => {
  it("R1/R3/R4 over random records × configs (1000 cases)", {
    timeout: 60_000,
  }, () => {
    const rng = mulberry32(0xdecaf0);
    for (let i = 0; i < 1000; i++) {
      const record = randRecord(rng, 40);
      const cfg = randCfg(rng);
      const label = `case#${i} cfg(min=${cfg.minRecentTurns},recent=${cfg.recentWindowTokens},max=${cfg.maxRecentWindowTokens}) len=${record.length}`;

      const b1 = checkBoundary(label, record, cfg);

      // R4 — determinism: a second call on the identical inputs agrees.
      expect(selectBoundary(record, cfg), `${label} :: non-deterministic`).toBe(
        b1,
      );

      // tailWithinTokenBudget structural contract (the boundary picker's sibling
      // budget primitive): result is a strict suffix, droppedBlocks accounts for
      // the head, and the result is non-empty iff the input was.
      const budget = cfg.maxRecentWindowTokens;
      const tail = tailWithinTokenBudget(record, budget);
      expect(
        tail.droppedBlocks + tail.blocks.length,
        `${label} :: tailWithinTokenBudget lost blocks`,
      ).toBe(record.length);
      expect(
        record.length === 0
          ? tail.blocks.length === 0
          : tail.blocks.length >= 1,
        `${label} :: tailWithinTokenBudget non-empty rule`,
      ).toBe(true);
      // The kept blocks are the exact tail suffix at droppedBlocks.
      expect(
        tail.blocks,
        `${label} :: tailWithinTokenBudget not a suffix`,
      ).toEqual(record.slice(tail.droppedBlocks));
    }
  });

  it("R2 — pathological records never throw", () => {
    const cfg = DEFAULT_COMPACTION_CONFIG;
    const small: CompactionConfig = {
      ...cfg,
      recentWindowTokens: 1,
      maxRecentWindowTokens: 5,
      minRecentTurns: 0,
    };
    const u = (text: string): TerminalRecordBlock => ({ kind: "user", text });
    const h = (text: string): TerminalRecordBlock => ({
      kind: "herta",
      surface: "speech",
      text,
    });
    const sys = (body: string): TerminalRecordBlock => ({
      kind: "system",
      label: "系统",
      body,
    });

    const huge = "长".repeat(100_000) + "x".repeat(100_000);
    const cases: { label: string; record: TerminalRecord }[] = [
      { label: "empty", record: [] },
      { label: "all-user", record: [u("a"), u("b"), u("c"), u("d"), u("e")] },
      { label: "no-user", record: [h("a"), sys("b"), h("c"), sys("d")] },
      { label: "single-enormous-user", record: [u(huge)] },
      { label: "single-enormous-herta", record: [h(huge)] },
      {
        label: "thousands-tiny",
        record: Array.from({ length: 4000 }, (_, i) =>
          i % 3 === 0 ? u("x") : i % 3 === 1 ? h("y") : sys("z"),
        ),
      },
      { label: "leading-nonuser", record: [sys("a"), h("b"), u("c"), h("d")] },
      { label: "trailing-nonuser", record: [u("a"), h("b"), sys("c")] },
    ];

    for (const { label, record } of cases) {
      for (const c of [cfg, small]) {
        // R1/R3 also hold on these shapes — checkBoundary asserts them.
        expect(
          () => checkBoundary(label, record, c),
          `${label} threw`,
        ).not.toThrow();
        expect(() => recordSpanTokens(record, 0, record.length)).not.toThrow();
        expect(() => tailWithinTokenBudget(record, 5)).not.toThrow();
      }
    }
  });
});

describe("recap token estimators — algebra fuzz", () => {
  it("R5 over random text & records (1000 cases)", { timeout: 60_000 }, () => {
    const rng = mulberry32(0x70cab5);
    // R5 baselines.
    expect(estimatePromptTokens(""), "empty -> 0").toBe(0);

    for (let i = 0; i < 1000; i++) {
      const a = randText(rng, 8);
      const b = randText(rng, 8);
      const label = `case#${i} a=${JSON.stringify(a.slice(0, 24))} b=${JSON.stringify(b.slice(0, 24))}`;

      const ta = estimatePromptTokens(a);
      const tb = estimatePromptTokens(b);
      const tab = estimatePromptTokens(a + b);

      // Non-negative integers.
      expect(Number.isInteger(ta) && ta >= 0, `${label} :: ta not a nat`).toBe(
        true,
      );
      expect(
        Number.isInteger(tab) && tab >= 0,
        `${label} :: tab not a nat`,
      ).toBe(true);
      // Determinism (R4).
      expect(estimatePromptTokens(a), `${label} :: estimate non-det`).toBe(ta);
      // Monotone under append & prepend: adding text never lowers the estimate.
      expect(
        tab >= ta,
        `${label} :: append shrank estimate (${tab} < ${ta})`,
      ).toBe(true);
      expect(
        tab >= tb,
        `${label} :: prepend shrank estimate (${tab} < ${tb})`,
      ).toBe(true);

      // recordSpanTokens algebra on a random record.
      const record = randRecord(rng, 20);
      const full = recordSpanTokens(record, 0, record.length);
      expect(
        Number.isInteger(full) && full >= 0,
        `${label} :: span not a nat`,
      ).toBe(true);
      // Empty span is 0.
      expect(recordSpanTokens(record, 3, 3), `${label} :: empty span`).toBe(0);
      // Exact additivity across a split point.
      const k = Math.floor(rng() * (record.length + 1));
      expect(
        recordSpanTokens(record, 0, k) +
          recordSpanTokens(record, k, record.length),
        `${label} :: span not additive at ${k}`,
      ).toBe(full);
      // Monotone in the end bound.
      if (record.length > 0) {
        const m = Math.floor(rng() * record.length);
        expect(
          recordSpanTokens(record, 0, m) <= recordSpanTokens(record, 0, m + 1),
          `${label} :: span not monotone at ${m}`,
        ).toBe(true);
      }
      // Robust to out-of-range indices — undefined slots are skipped, so an
      // over-wide span equals the in-range full span (never throws, never NaN).
      expect(
        recordSpanTokens(record, -5, record.length + 5),
        `${label} :: out-of-range span diverged`,
      ).toBe(full);
    }
  });
});

// ---------------------------------------------------------------------------
// Completeness pass (2026-07-09). The sweeps above prove SAFETY (a boundary is
// never out of range / never a non-user block) but not LIVENESS: every one of
// them still passes under a trivial `selectBoundary = () => 0`. The invariants
// below pin the three things the safety sweep cannot see —
//   L1. all THREE real consumers validate a boundary identically (parity),
//   L2. selectBoundary actually MAKES PROGRESS on genuinely over-budget records
//       (and gives up ONLY on an enumerated set of shapes),
//   L3. the boundary never REGRESSES as the conversation grows (monotonicity),
//   L4. the token estimator's ÷4 treatment of exotic (non-BMP, non-CJK-BMP)
//       scripts is a visible, floored decision — not an accident.
// ---------------------------------------------------------------------------

// Minimal static prefix so serializeActorPrompt yields a record-dominated
// string (empty bio/env/fewShots ⇒ the prefix contributes nothing) — used to
// build genuinely over-budget prompts the way the runtime measures them.
const EMPTY_PREFIX: StaticHertaPrefix = { bio: "", env: "", fewShots: [] };

/** Tokens of the ACTUAL serialized prompt (prefix + record + open tag) — what
 *  prepareTurnRecap measures against compactThreshold to decide to compact. */
function serializedPromptTokens(record: TerminalRecord): number {
  return estimatePromptTokens(
    serializeActorPrompt({
      staticPrefix: EMPTY_PREFIX,
      record,
      priorTurnLength: record.length,
      recapBoundaryIndex: 0,
      openTag: "（我 说）",
    }),
  );
}

function mkUser(text: string): TerminalRecordBlock {
  return { kind: "user", text };
}
function mkSys(body: string): TerminalRecordBlock {
  return { kind: "system", label: "系统", body };
}
/** A user block whose raw text estimates to exactly `tok` tokens (4 ASCII
 *  chars ⇒ 1 token, ceil(4·tok/4) = tok). Lets the liveness sweep predict the
 *  exact boundary selectBoundary must pick. */
function userTurn(tok: number): TerminalRecordBlock {
  return mkUser("a".repeat(4 * tok));
}

// The boundary-validation predicate as each of the three real consumers of a
// persisted boundary writes it. Transcribed from source, NOT deduplicated —
// the point of L1 is to prove they are now byte-equivalent (fix (2) added the
// runtime's `<= 0` lower bound). If any consumer drifts, the parity assertion
// below turns red.

// cli/src/app/main.ts — `recapBoundaryIndex` guard (positive/keep form).
function cliKeep(record: TerminalRecord, i: number): boolean {
  return i > 0 && i < record.length && record[i]?.kind === "user";
}
// app-server/src/session.ts — `recapBoundaryIndex` guard (positive/keep form,
// spelled identically to cli).
function serverKeep(record: TerminalRecord, i: number): boolean {
  return i > 0 && i < record.length && record[i]?.kind === "user";
}
// session-recap-runtime.ts — the cache DISCARD predicate, negated to keep form.
// Fix (2) added `boundaryIndex <= 0`; before that this branch relied on the
// implicit `stickyBoundary <= 0` check downstream, an unproven cross-module
// coupling. With the lower bound explicit it is now identical to the two above.
function runtimeKeep(record: TerminalRecord, i: number): boolean {
  const discard = i <= 0 || i >= record.length || record[i]?.kind !== "user";
  return !discard;
}

describe("recap selectBoundary — consumer parity (L1)", () => {
  it("all three consumer predicates are literally equivalent, and agree with selectBoundary's output (1000 cases)", {
    timeout: 60_000,
  }, () => {
    const rng = mulberry32(0xc0ffee);
    for (let i = 0; i < 1000; i++) {
      const record = randRecord(rng, 40);
      const cfg = randCfg(rng);
      const label = `case#${i} len=${record.length}`;

      // Equivalence over arbitrary probe indices, including 0, negatives, and
      // out-of-range (the exact adversarial inputs a stale sidecar produces).
      for (const probe of [
        -3,
        -1,
        0,
        1,
        Math.floor(rng() * (record.length + 2)),
        record.length - 1,
        record.length,
        record.length + 5,
      ]) {
        const c = cliKeep(record, probe);
        const s = serverKeep(record, probe);
        const r = runtimeKeep(record, probe);
        expect(
          c === s && s === r,
          `${label} :: predicates diverge at i=${probe} (cli=${c} server=${s} runtime=${r})`,
        ).toBe(true);
      }

      // selectBoundary's output must satisfy all three: a real boundary (b > 0)
      // is accepted by every consumer; the "no compaction" sentinel (b === 0)
      // is rejected by every consumer (0 is never a persisted boundary).
      const b = selectBoundary(record, cfg);
      const c = cliKeep(record, b);
      const s = serverKeep(record, b);
      const r = runtimeKeep(record, b);
      expect(
        c === s && s === r,
        `${label} :: consumers disagree on selectBoundary output ${b}`,
      ).toBe(true);
      expect(
        c,
        `${label} :: selectBoundary output ${b} ${b > 0 ? "rejected" : "accepted"} by consumers (expected ${b > 0})`,
      ).toBe(b > 0);
    }
  });
});

describe("recap selectBoundary — liveness / effectiveness (L2)", () => {
  // The safety sweep passes even if selectBoundary always gives up. This sweep
  // constructs records that are DEFINITELY over budget AND have a summarizable
  // head, and pins the EXACT boundary selectBoundary must return — so a
  // regression that makes it give up eagerly (→ 0) turns red immediately.
  it("makes progress on over-budget records with a summarizable head (1000 cases)", {
    timeout: 60_000,
  }, () => {
    const rng = mulberry32(0x11feed);
    for (let i = 0; i < 1000; i++) {
      const t = 16 + Math.floor(rng() * 100); // per-turn tokens
      const n = 4 + Math.floor(rng() * 9); // 4..12 user turns
      const m = Math.floor(rng() * 3); // minRecentTurns 0..2
      const floor = Math.max(1, m);
      // keptTarget ∈ [floor .. n-2] ⇒ at least 2 head turns remain to summarize.
      const keptTarget = floor + Math.floor(rng() * (n - 2 - floor + 1));
      const recent = keptTarget * t; // tail fills exactly at keptTarget turns
      const maxRecent = (n + 5) * t; // hard cap never bites (isolates case (b))

      // One user block per turn ⇒ userIdx[j] === j and each turn spans t tokens.
      const record: TerminalRecord = Array.from({ length: n }, () =>
        userTurn(t),
      );
      const cfg: CompactionConfig = {
        ...DEFAULT_COMPACTION_CONFIG,
        contextWindowTokens: n * t,
        bufferFraction: 0.2,
        recentWindowTokens: recent,
        maxRecentWindowTokens: maxRecent,
        minRecentTurns: m,
      };
      const label = `case#${i} n=${n} t=${t} m=${m} kept=${keptTarget}`;

      // Genuinely over the compaction engage threshold (measured the runtime's
      // way — via the serialized prompt, not a hand-rolled token count).
      expect(
        serializedPromptTokens(record) > compactThreshold(cfg),
        `${label} :: record not over compactThreshold`,
      ).toBe(true);

      // The tail keeps exactly `keptTarget` newest turns; the boundary is the
      // start of the oldest kept turn = index n - keptTarget (> 0).
      const b = selectBoundary(record, cfg);
      expect(
        b > 0,
        `${label} :: gave up (boundary 0) on a compactable record`,
      ).toBe(true);
      expect(b, `${label} :: boundary not at expected head/tail seam`).toBe(
        n - keptTarget,
      );
    }
  });

  // The ONLY shapes selectBoundary is permitted to give up on (return 0) while
  // still over budget: a single user turn (no head to summarize) and a purely
  // non-user head (the boundary can only point at a user block). Pinning them
  // means a regression that ADDS a give-up path (or removes one of these) turns
  // red. Note: the newest-turn-over-cap shape is NO LONGER a give-up shape after
  // the min=0 floor-of-1 fix (2026-07-09) — it now makes progress (see G3).
  it("gives up (returns 0) exactly on the enumerated degenerate shapes", () => {
    const overBudget = (
      record: TerminalRecord,
      cfg: CompactionConfig,
      label: string,
    ) =>
      expect(
        serializedPromptTokens(record) > compactThreshold(cfg),
        `${label} :: precondition — record must be over budget`,
      ).toBe(true);
    const smallCtx = (cfg: Partial<CompactionConfig>): CompactionConfig => ({
      ...DEFAULT_COMPACTION_CONFIG,
      contextWindowTokens: 100,
      bufferFraction: 0.2, // threshold 80
      ...cfg,
    });

    // G1 — a single user turn (generalizes to n ≤ minRecentTurns): there is no
    // head to summarize; the loop consumes the only turn and boundary collapses
    // to userIdx[0] ⇒ 0. Holds regardless of how enormous that turn is.
    for (const m of [0, 1, 4]) {
      const record: TerminalRecord = [userTurn(1000)];
      const cfg = smallCtx({
        recentWindowTokens: 1,
        maxRecentWindowTokens: 50,
        minRecentTurns: m,
      });
      overBudget(record, cfg, `G1 m=${m}`);
      expect(selectBoundary(record, cfg), `G1 m=${m} :: expected give-up`).toBe(
        0,
      );
    }

    // G2 — a purely-non-user head. The bloat is all `→ 系统` blocks BEFORE the
    // first user turn; the recent window is wide enough to keep every user turn,
    // so the boundary reaches userIdx[0] ⇒ 0. selectBoundary can only point at a
    // user block, so a non-user head is never summarizable on its own.
    {
      // Two different bodies: identical consecutive summary lines merge into
      // one with a count (ADR 0079), which would shrink the head under budget.
      const record: TerminalRecord = [
        mkSys("a".repeat(4000)),
        mkSys("b".repeat(4000)),
        mkUser("hi"),
        mkUser("there"),
      ];
      const cfg = smallCtx({
        recentWindowTokens: 1_000_000,
        maxRecentWindowTokens: 1_000_000,
        minRecentTurns: 0,
      });
      overBudget(record, cfg, "G2");
      expect(selectBoundary(record, cfg), "G2 :: expected give-up").toBe(0);
    }

    // G3 — the NEWEST turn alone exceeds the hard cap at minRecentTurns=0. This
    // USED to give up (return 0): the cap-break fired on the first iteration
    // before anything was kept. The floor-of-1 fix (2026-07-09) keeps the newest
    // turn, so the boundary now ADVANCES to it (index 2) — progress, not give-up.
    {
      const record: TerminalRecord = [userTurn(5), userTurn(5), userTurn(1000)];
      const cfg = smallCtx({
        recentWindowTokens: 1,
        maxRecentWindowTokens: 50,
        minRecentTurns: 0,
      });
      overBudget(record, cfg, "G3");
      expect(
        selectBoundary(record, cfg),
        "G3 :: newest-turn-over-cap now advances (fix), no longer gives up",
      ).toBe(2);
    }
  });
});

describe("recap selectBoundary — monotonicity under append (L3)", () => {
  // session-recap-runtime's roll path advances the boundary as the record
  // grows; it assumes the boundary never REGRESSES when blocks are appended.
  // Holds for ALL minRecentTurns including 0 since the floor-of-1 fix
  // (2026-07-09): the newest turn is always kept, so a longer tail only pushes
  // the boundary FORWARD. The discrete case below pins the exact min=0 scenario
  // the fix repaired.
  it("selectBoundary(R ++ S) >= selectBoundary(R) for all minRecentTurns (1000 cases)", {
    timeout: 60_000,
  }, () => {
    const rng = mulberry32(0x6b0a7d);
    const anyMinCfg = (): CompactionConfig => {
      const cfg = randCfg(rng);
      // Draw min from {0,1,2,4} — 0 included now that the fix makes it monotone.
      const min = [0, 1, 2, 4][Math.floor(rng() * 4)] ?? 0;
      return { ...cfg, minRecentTurns: min };
    };
    for (let i = 0; i < 1000; i++) {
      const r = randRecord(rng, 30);
      const s = randRecord(rng, 12);
      const cfg = anyMinCfg();
      const rs = [...r, ...s];
      const label = `case#${i} |R|=${r.length} |S|=${s.length} min=${cfg.minRecentTurns}`;

      const before = selectBoundary(r, cfg);
      const after = selectBoundary(rs, cfg);
      expect(
        after >= before,
        `${label} :: boundary regressed on append (${before} -> ${after})`,
      ).toBe(true);
    }
  });

  // Verifies the minRecentTurns === 0 monotonicity FIX (2026-07-09). Before
  // the fix, appending a trailing non-user block that pushed the newest turn
  // over maxRecentWindowTokens made the cap-break fire on the first iteration
  // (nothing force-kept at floor 0) and the boundary collapsed to 0 — a
  // non-monotonicity the roll path assumes away. The fix guards the cap-break
  // with `kept >= Math.max(1, cfg.minRecentTurns)`, so the single newest turn
  // is always kept and the boundary advances instead of giving up.
  it("keeps ≥1 turn at minRecentTurns === 0 so the boundary never regresses", () => {
    const cfg: CompactionConfig = {
      ...DEFAULT_COMPACTION_CONFIG,
      recentWindowTokens: 1,
      maxRecentWindowTokens: 50,
      minRecentTurns: 0,
    };
    const r: TerminalRecord = [userTurn(10), userTurn(10), userTurn(10)];
    // R alone: tail fills after the newest turn (recent=1 ≤ 10 tok), boundary
    // is the start of the last kept turn = index 2.
    expect(selectBoundary(r, cfg), "R boundary").toBe(2);
    // Appending a large `→ 系统` block makes the newest turn's span exceed the
    // 50-tok cap; with the floor-of-1 fix the newest turn is still kept, so the
    // boundary stays at 2 (monotone) instead of collapsing to 0.
    const rs: TerminalRecord = [...r, mkSys("a".repeat(400))];
    expect(
      selectBoundary(rs, cfg),
      "R++S boundary must not regress below R's",
    ).toBe(2);
  });
});

describe("recap estimatePromptTokens — non-ASCII floor (L4)", () => {
  // DESIGN NOTE (pinned, revised 2026-07-17): the estimator counts EVERY
  // non-ASCII codepoint as ~1 token/char; only ASCII runs get ÷4. The
  // previous heuristic gave 1/char ONLY to BMP CJK ranges, so emoji,
  // CJK-Ext-B (real Han above the BMP), Hangul, Cyrillic, and Arabic fell
  // into the ÷4 run — an up-to-4× UNDERCOUNT, the dangerous direction for
  // the compaction threshold (with `enabled: true` the real prompt could
  // blow past the model window while the estimate still read under
  // high-water, so compaction never fired). Charging 1/char for all
  // non-ASCII bounds the error and keeps it mostly on the safe (over-
  // reserve) side.
  it("counts every non-ASCII codepoint as ~1 token, with a non-zero floor", () => {
    const NON_ASCII: { name: string; cp: number }[] = [
      { name: "emoji U+1F600", cp: 0x1f600 },
      { name: "CJK-Ext-B U+20000 (non-BMP Han)", cp: 0x20000 },
      { name: "Hangul U+AC00", cp: 0xac00 },
      { name: "Cyrillic U+0410", cp: 0x0410 },
      { name: "Arabic U+0627", cp: 0x0627 },
    ];
    for (const { name, cp } of NON_ASCII) {
      const ch = String.fromCodePoint(cp);
      for (const n of [1, 2, 3, 4, 5, 8, 17, 40]) {
        const s = ch.repeat(n);
        expect(
          estimatePromptTokens(s),
          `${name} × ${n} :: not counted 1 token/char`,
        ).toBe(n);
        // Floor: non-empty non-ASCII content never estimates to 0 tokens.
        expect(
          estimatePromptTokens(s) >= 1,
          `${name} × ${n} :: estimate underflowed to 0`,
        ).toBe(true);
      }
    }

    // Contrast pin, revised 2026-09-21 (ADR 0068 §9): BMP Han carries the
    // MEASURED weight — 0.65 token per ideograph, against the API's own
    // count — while its NON-BMP sibling (U+20000, also a Han ideograph, never
    // measured) stays at the conservative 1. Neither falls into the ÷4 run,
    // which was the undercount this block exists to keep out.
    const bmpHan = String.fromCodePoint(0x4e00).repeat(40);
    const extHan = String.fromCodePoint(0x20000).repeat(40);
    expect(estimatePromptTokens(bmpHan), "BMP Han counts 0.65/char").toBe(26);
    expect(estimatePromptTokens(extHan), "non-BMP Han counts 1/char").toBe(40);
    expect(
      estimatePromptTokens(bmpHan),
      "Han never falls into the ÷4 ASCII run",
    ).toBeGreaterThan(10);

    // ASCII runs still compress ÷4 — the cheap side of the heuristic.
    expect(estimatePromptTokens("a".repeat(40)), "ASCII ÷4").toBe(10);
    // Mixed: non-ASCII flushes the pending ASCII run.
    expect(estimatePromptTokens(`abcd${"가".repeat(3)}ab`), "mixed").toBe(
      1 + 3 + 1,
    );
  });
});
