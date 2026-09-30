import { describe, expect, it } from "vitest";
import type { Message } from "../types/transcript.js";
import {
  DEFAULT_BACKEND_PROMPT_BUDGET,
  estimateFrameBaseTokens,
  estimateMessagesTokens,
  fitMessagesToBudget,
} from "./context-budget.js";

describe("estimate memoization (2026-09-03)", () => {
  it("a message's estimate is a fact about the OBJECT — the transcript never mutates one after append", () => {
    // The memo keys on identity. The test pins the contract it leans on:
    // a mutated message keeps its first estimate, so nothing may mutate
    // one (TranscriptStore appends; the phase-1 clear builds a new object).
    const m: Message = {
      role: "assistant",
      text: "汉".repeat(100),
      toolCalls: [],
      ts,
    };
    // 100 Han at the measured 0.65 (= 65) + the two "\n" joiners (÷4 → 1)
    // + the 4-token overhead.
    const first = estimateMessagesTokens([m]);
    expect(first).toBe(70);
    (m as { text: string }).text = "汉".repeat(1000);
    expect(estimateMessagesTokens([m])).toBe(first);
    // A new object with the same content is estimated afresh.
    expect(estimateMessagesTokens([{ ...m, text: "汉".repeat(1000) }])).toBe(
      655,
    );
  });

  it("the frame's invariant part is memoized per frame object; only the state trailer is walked per call", () => {
    const frame = {
      backendSystem: "x".repeat(400),
      scopedRepoInstructions: "",
      scopedMemory: "",
      toolSchemas: [],
    };
    const base = estimateFrameBaseTokens(frame, "");
    expect(base).toBe(
      100 + estimateFrameBaseTokens({ ...frame, backendSystem: "" }, ""),
    );
    // 10 Han = ceil(6.5) = 7 estimated tokens.
    expect(estimateFrameBaseTokens(frame, "汉".repeat(10))).toBe(base + 7);
    // Same object, same answer — the contract text is not re-walked.
    expect(estimateFrameBaseTokens(frame, "")).toBe(base);
  });
});

const ts = "2026-07-22T00:00:00.000Z";

function assistant(text: string, calls: string[] = []): Message {
  return {
    role: "assistant",
    text,
    toolCalls: calls.map((id) => ({ id, tool: "read_file", input: {} })),
    ts,
  };
}

function tool(id: string, payload: string): Message {
  return {
    role: "tool",
    toolCallId: id,
    result: { ok: true, summary: `did ${id}`, data: { content: payload } },
    ts,
  };
}

/** N groups of (assistant + one fat tool reply). */
function groups(n: number, payloadChars: number): Message[] {
  const out: Message[] = [];
  for (let i = 0; i < n; i += 1) {
    out.push(assistant(`step ${i}`, [`c${i}`]));
    out.push(tool(`c${i}`, "x".repeat(payloadChars)));
  }
  return out;
}

describe("fitMessagesToBudget", () => {
  it("passes an under-budget frame through untouched", () => {
    const messages = groups(3, 100);
    const fit = fitMessagesToBudget({
      messages,
      baseTokens: 1_000,
      budget: DEFAULT_BACKEND_PROMPT_BUDGET,
      lang: "zh",
    });
    expect(fit.overBudget).toBe(false);
    expect(fit.clearedPayloads).toBe(0);
    expect(fit.droppedGroups).toBe(0);
    expect(fit.messages).toEqual(messages);
  });

  it("phase 1: clears old tool payloads but keeps the newest K verbatim", () => {
    const messages = groups(6, 4_000); // ~1K tokens per payload
    const fit = fitMessagesToBudget({
      messages,
      baseTokens: 0,
      budget: { budgetTokens: 3_500, keepRecentToolPayloads: 2 },
      lang: "zh",
    });
    expect(fit.overBudget).toBe(false);
    expect(fit.clearedPayloads).toBe(4);
    expect(fit.droppedGroups).toBe(0);
    // Oldest tool message cleared to a summary+marker…
    const first = fit.messages[1];
    expect(first?.role).toBe("tool");
    if (first?.role === "tool") {
      expect(first.result.summary).toBe("did c0");
      expect((first.result.data as { cleared?: boolean }).cleared).toBe(true);
    }
    // …newest kept whole.
    const last = fit.messages[fit.messages.length - 1];
    if (last?.role === "tool") {
      expect((last.result.data as { content?: string }).content?.length).toBe(
        4_000,
      );
    }
  });

  it("phase 2: drops oldest groups, keeps pairing and the final group, prepends a marker", () => {
    // Fat ASSISTANT texts so phase-1 payload clearing cannot save it.
    const messages: Message[] = [];
    for (let i = 0; i < 5; i += 1) {
      messages.push(assistant("a".repeat(8_000), [`c${i}`]));
      messages.push(tool(`c${i}`, "small"));
    }
    const fit = fitMessagesToBudget({
      messages,
      baseTokens: 0,
      budget: { budgetTokens: 5_000, keepRecentToolPayloads: 2 },
      lang: "en",
    });
    expect(fit.overBudget).toBe(false);
    expect(fit.droppedGroups).toBeGreaterThan(0);
    // Marker first, then intact groups.
    const marker = fit.messages[0];
    expect(marker?.role).toBe("assistant");
    if (marker?.role === "assistant") {
      expect(marker.text).toContain("context trimmed");
      expect(marker.toolCalls).toHaveLength(0);
    }
    // Pairing invariant: every assistant-with-calls is immediately followed
    // by its tool replies.
    for (let i = 0; i < fit.messages.length; i += 1) {
      const m = fit.messages[i];
      if (m?.role === "assistant" && m.toolCalls.length > 0) {
        const next = fit.messages[i + 1];
        expect(next?.role).toBe("tool");
        if (next?.role === "tool") {
          expect(next.toolCallId).toBe(m.toolCalls[0]?.id);
        }
      }
    }
    // The final group survived whole.
    const lastTool = fit.messages[fit.messages.length - 1];
    expect(lastTool?.role).toBe("tool");
    if (lastTool?.role === "tool") expect(lastTool.toolCallId).toBe("c4");
  });

  it("reports overBudget when even the minimal tail exceeds the budget", () => {
    const messages = groups(2, 50);
    const fit = fitMessagesToBudget({
      messages,
      baseTokens: 1_000_000, // base frame alone blows the budget
      budget: { budgetTokens: 10_000, keepRecentToolPayloads: 2 },
      lang: "zh",
    });
    expect(fit.overBudget).toBe(true);
  });

  it("is deterministic and does not mutate its input", () => {
    const messages = groups(6, 4_000);
    const snapshot = JSON.parse(JSON.stringify(messages));
    const budget = { budgetTokens: 3_500, keepRecentToolPayloads: 2 };
    const a = fitMessagesToBudget({
      messages,
      baseTokens: 0,
      budget,
      lang: "zh",
    });
    const b = fitMessagesToBudget({
      messages,
      baseTokens: 0,
      budget,
      lang: "zh",
    });
    expect(a).toEqual(b);
    expect(messages).toEqual(snapshot);
  });

  it("estimateMessagesTokens charges Han far above the ASCII ÷4 — 0.65 a character, as measured", () => {
    const ascii = estimateMessagesTokens([assistant("a".repeat(400))]);
    const cjk = estimateMessagesTokens([assistant("汉".repeat(400))]);
    // 260 against 100 (+ the same small overhead on both).
    expect(cjk).toBeGreaterThan(ascii * 2.4);
    expect(cjk).toBeLessThan(ascii * 2.7);
  });
});

describe("trim boundaries move in steps (ADR 0068 §7)", () => {
  const verbatim = (messages: readonly Message[]): number =>
    messages.filter(
      (m) =>
        m.role === "tool" &&
        (m.result.data as { cleared?: boolean }).cleared !== true,
    ).length;

  it("phase 1 clears up to a multiple of the step: the window holds keep…keep+step−1 payloads", () => {
    // 20 payloads, keep 8, step 8 → 12 clearable → 8 cleared, 12 verbatim.
    const fit = fitMessagesToBudget({
      messages: groups(20, 4_000),
      baseTokens: 0,
      budget: { budgetTokens: 15_000, keepRecentToolPayloads: 8 },
      lang: "zh",
    });
    expect(fit.overBudget).toBe(false);
    expect(fit.clearedPayloads).toBe(8);
    expect(verbatim(fit.messages)).toBe(12);
    // One more group moves nothing: 13 clearable is still 8 cleared.
    const next = fitMessagesToBudget({
      messages: groups(21, 4_000),
      baseTokens: 0,
      budget: { budgetTokens: 15_000, keepRecentToolPayloads: 8 },
      lang: "zh",
    });
    expect(next.clearedPayloads).toBe(8);
    expect(verbatim(next.messages)).toBe(13);
  });

  it("falls back to the EXACT boundary when the stepped one does not fit — what fit before still fits", () => {
    // 12 verbatim payloads (~12K) do not fit 10K; the exact 8 (~8K) do.
    const fit = fitMessagesToBudget({
      messages: groups(20, 4_000),
      baseTokens: 0,
      budget: { budgetTokens: 10_000, keepRecentToolPayloads: 8 },
      lang: "zh",
    });
    expect(fit.overBudget).toBe(false);
    expect(fit.droppedGroups).toBe(0);
    expect(fit.clearedPayloads).toBe(12);
    expect(verbatim(fit.messages)).toBe(8);
    // …which is what step 1 — the old behaviour — answers, message for message.
    const old = fitMessagesToBudget({
      messages: groups(20, 4_000),
      baseTokens: 0,
      budget: {
        budgetTokens: 10_000,
        keepRecentToolPayloads: 8,
        boundaryStep: 1,
      },
      lang: "zh",
    });
    expect(fit.messages).toEqual(old.messages);
  });

  it("phase 2 rounds the dropped count UP to the step, and still keeps the final group", () => {
    const messages: Message[] = [];
    for (let i = 0; i < 30; i += 1) {
      messages.push(assistant("a".repeat(8_000), [`c${i}`])); // ~2K each
      messages.push(tool(`c${i}`, "small"));
    }
    const budget = { budgetTokens: 35_000, keepRecentToolPayloads: 8 };
    const fit = fitMessagesToBudget({
      messages,
      baseTokens: 0,
      budget,
      lang: "en",
    });
    const exact = fitMessagesToBudget({
      messages,
      baseTokens: 0,
      budget: { ...budget, boundaryStep: 1 },
      lang: "en",
    });
    expect(fit.overBudget).toBe(false);
    expect(exact.droppedGroups % 8).not.toBe(0); // anti-vacuous: rounding did something
    expect(fit.droppedGroups % 8).toBe(0);
    expect(fit.droppedGroups).toBeGreaterThanOrEqual(exact.droppedGroups);
    expect(fit.droppedGroups - exact.droppedGroups).toBeLessThan(8);
    expect(fit.estimatedTokens).toBeLessThanOrEqual(budget.budgetTokens);
    const lastTool = fit.messages[fit.messages.length - 1];
    if (lastTool?.role === "tool") expect(lastTool.toolCallId).toBe("c29");
  });

  it("a single over-budget group has nothing to drop and announces nothing", () => {
    const fit = fitMessagesToBudget({
      messages: [assistant("a".repeat(80_000), ["c0"]), tool("c0", "small")],
      baseTokens: 0,
      budget: { budgetTokens: 5_000, keepRecentToolPayloads: 2 },
      lang: "en",
    });
    expect(fit.overBudget).toBe(true);
    expect(fit.droppedGroups).toBe(0);
    expect(fit.messages).toHaveLength(2);
  });

  it("a message's cleared stub is ONE object — stable bytes, one estimate", () => {
    const messages = groups(20, 4_000);
    const budget = { budgetTokens: 15_000, keepRecentToolPayloads: 8 };
    const a = fitMessagesToBudget({
      messages,
      baseTokens: 0,
      budget,
      lang: "zh",
    });
    const b = fitMessagesToBudget({
      messages: [...messages, ...groups(1, 4_000)],
      baseTokens: 0,
      budget,
      lang: "zh",
    });
    expect(a.messages[1]).toBe(b.messages[1]);
    expect(a.messages[1]).not.toBe(messages[1]);
  });

  /**
   * Replay one growing brief, a frame per iteration, and bill it the way a
   * prefix cache does: everything after the first message that differs
   * from the previous frame is paid for again.
   */
  function replay(
    grow: (i: number) => Message[],
    iterations: number,
    budget: {
      budgetTokens: number;
      keepRecentToolPayloads: number;
      boundaryStep?: number;
    },
  ): { rebilled: number; rewrites: number; trimmedFrames: number } {
    const transcript: Message[] = [];
    let prev: string[] = [];
    let rebilled = 0;
    let rewrites = 0;
    let trimmedFrames = 0;
    for (let i = 0; i < iterations; i += 1) {
      transcript.push(...grow(i));
      const fit = fitMessagesToBudget({
        messages: transcript,
        baseTokens: 0,
        budget,
        lang: "zh",
      });
      expect(fit.overBudget).toBe(false);
      if (fit.clearedPayloads > 0 || fit.droppedGroups > 0) trimmedFrames += 1;
      const wire = fit.messages.map((m) => JSON.stringify(m));
      let common = 0;
      while (
        common < wire.length &&
        common < prev.length &&
        wire[common] === prev[common]
      )
        common += 1;
      // A rewrite: an earlier frame's bytes changed, not merely grew.
      if (common < prev.length) rewrites += 1;
      rebilled += estimateMessagesTokens(fit.messages.slice(common));
      prev = wire;
    }
    return { rebilled, rewrites, trimmedFrames };
  }

  it("a long brief over budget: the exact boundary rewrites the frame on every call, the stepped one about once per step", () => {
    // ~4K-token payloads + ~0.5K of reasoning per iteration; the budget is
    // crossed near iteration 27 and phase-1 clearing holds it from there on.
    const grow = (i: number): Message[] => [
      {
        ...assistant(`step ${i}`, [`c${i}`]),
        reasoningContent: "r".repeat(2_000),
      } as Message,
      tool(`c${i}`, "x".repeat(16_000)),
    ];
    const budget = { budgetTokens: 120_000, keepRecentToolPayloads: 8 };
    const exact = replay(grow, 80, { ...budget, boundaryStep: 1 });
    const stepped = replay(grow, 80, budget);

    // The old shape, measured: once trimming starts, EVERY frame rewrites.
    expect(exact.trimmedFrames).toBeGreaterThan(40);
    expect(exact.rewrites).toBe(exact.trimmedFrames);
    // The new one: a rewrite when a boundary moves, append-only in between.
    expect(stepped.trimmedFrames).toBeGreaterThan(40);
    expect(stepped.rewrites).toBeLessThanOrEqual(
      Math.ceil(stepped.trimmedFrames / 8) + 1,
    );
    expect(stepped.rebilled).toBeLessThan(exact.rebilled * 0.5);
  });

  it("the same when it is the HISTORY that is dropped: the marker — the first message — holds still between steps", () => {
    // Fat reasoning, small payloads: clearing cannot help, groups must go.
    const grow = (i: number): Message[] => [
      {
        ...assistant(`step ${i}`, [`c${i}`]),
        reasoningContent: "r".repeat(12_000),
      } as Message,
      tool(`c${i}`, "small"),
    ];
    const budget = { budgetTokens: 60_000, keepRecentToolPayloads: 8 };
    const exact = replay(grow, 70, { ...budget, boundaryStep: 1 });
    const stepped = replay(grow, 70, budget);

    expect(exact.trimmedFrames).toBeGreaterThan(40);
    expect(exact.rewrites).toBeGreaterThan(exact.trimmedFrames * 0.9);
    expect(stepped.rewrites).toBeLessThanOrEqual(
      Math.ceil(stepped.trimmedFrames / 8) * 2 + 2,
    );
    expect(stepped.rebilled).toBeLessThan(exact.rebilled * 0.4);
  });
});
