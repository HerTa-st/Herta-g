import {
  type AgentEvent,
  type CodingAgentRuntime,
  type CompletionEvent,
  type CompletionProviderAdapter,
  type CompletionRequest,
  type HertaToAgentBrief,
  InMemoryEventBus,
  type ProviderAdapter,
  type ProviderEvent,
} from "@herta/core";
import { describe, expect, it } from "vitest";
import type { MetaThinkCorpus, MoodState } from "./meta-think.js";
import type { ActorStreamingSink } from "./streaming-sink.js";
import { V2ActorDriver } from "./v2-actor-driver.js";

/**
 * The turn-latency changes of 2026-09-21 (ADR 0066 amendment):
 *
 *  1. the first thought starts while the router is still classifying, under
 *     the mood the turn has if it does not change — adopted ONLY when the
 *     prompt it was asked is byte-identical to the one the turn builds;
 *  2. a user message that pre-empts a dispatch (a bare `@板砖` + a brief) is
 *     not classified at all — the router's own first rule already decides it.
 *
 * Every case is judged against the SAME turn with speculation off: the
 * record and the prompts must be identical. Only WHEN requests leave differs.
 */

const STATES: readonly MoodState[] = [
  "默认",
  "被烦版",
  "教学版",
  "被戳穿版",
  "任务部署版",
  "板砖代答版",
  "被顶嘴版",
  "倾听版",
];
/** Every mood carries its own marker, so a prompt says which one it ran under. */
const corpus: MetaThinkCorpus = {
  preThink: Object.fromEntries(
    STATES.map((s) => [s, `〔pre-think:${s}〕`]),
  ) as MetaThinkCorpus["preThink"],
  preSpeak: Object.fromEntries(
    STATES.map((s) => [s, `〔pre-speak:${s}〕`]),
  ) as MetaThinkCorpus["preSpeak"],
};

const isThought = (req: CompletionRequest): boolean =>
  req.prompt.endsWith("（我 想）\n");
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
/** A turn signal nobody aborts. */
const live = (): AbortSignal => new AbortController().signal;
async function settle(): Promise<void> {
  for (let i = 0; i < 6; i += 1) await tick();
}

interface Call {
  readonly kind: "thought" | "speech";
  readonly prompt: string;
  readonly signal: AbortSignal;
  /** Router answers released at the moment this request LEFT. */
  readonly routerReleasedAtStart: boolean;
}

function harness(opts: {
  routerAnswer: string;
  speculativeThought: boolean;
  /** Hold the thought open after its first token until released. */
  gateThought?: boolean;
}) {
  const calls: Call[] = [];
  let routerCalls = 0;
  let routerReleased = false;
  let releaseRouter: () => void = () => {};
  const routerGate = new Promise<void>((r) => {
    releaseRouter = () => {
      routerReleased = true;
      r();
    };
  });
  let releaseThought: () => void = () => {};
  const thoughtGate = new Promise<void>((r) => {
    releaseThought = r;
  });

  const provider: CompletionProviderAdapter = {
    streamCompletion(
      req: CompletionRequest,
      signal: AbortSignal,
    ): AsyncIterable<CompletionEvent> {
      const kind = isThought(req) ? "thought" : "speech";
      calls.push({
        kind,
        prompt: req.prompt,
        signal,
        routerReleasedAtStart: routerReleased,
      });
      return (async function* () {
        if (kind === "thought") {
          yield { type: "text-delta", text: "先想清楚。" } as const;
          if (opts.gateThought === true) {
            await Promise.race([
              thoughtGate,
              new Promise<void>((_, reject) =>
                signal.addEventListener("abort", () =>
                  reject(new Error("aborted")),
                ),
              ),
            ]);
          }
          signal.throwIfAborted();
          yield { type: "text-delta", text: "（/我 想）" } as const;
        } else {
          yield { type: "text-delta", text: "嗯。（/我 说）" } as const;
        }
        yield { type: "finish", reason: "stop" } as const;
      })();
    },
  };
  const routerProvider: ProviderAdapter = {
    streamChat(): AsyncIterable<ProviderEvent> {
      routerCalls += 1;
      return (async function* () {
        await routerGate;
        yield { type: "text-delta", text: opts.routerAnswer } as const;
        yield { type: "finish", reason: "stop" } as const;
      })();
    },
  };
  const sinkLog: string[] = [];
  const sink: ActorStreamingSink = {
    beginHertaStream: (s) => sinkLog.push(`begin:${s}`),
    streamHertaToken: () => undefined,
    endHertaStream: () => sinkLog.push("end"),
    flushBlocks: () => undefined,
    setPersistHook: () => undefined,
  };
  let briefs = 0;
  const runtime = {
    runBrief: async (brief: HertaToAgentBrief) => {
      briefs += 1;
      return {
        taskId: brief.taskId,
        status: "completed" as const,
        evidence: [],
        changedFiles: [],
        tests: [],
        permissions: [],
        residualRisks: [],
      };
    },
  } as unknown as CodingAgentRuntime;
  const driver = new V2ActorDriver({
    provider,
    model: "test-model",
    staticPrefix: { bio: "[prefix]", env: "", fewShots: [] },
    bus: new InMemoryEventBus<AgentEvent>(),
    runtimeFactory: () => runtime,
    routerProvider,
    metaThinkCorpus: corpus,
    sink,
    speculativeThought: opts.speculativeThought,
  });
  return {
    driver,
    calls,
    sinkLog,
    routerCalls: () => routerCalls,
    briefs: () => briefs,
    releaseRouter,
    releaseThought,
  };
}

describe("the first thought starts while the router is still out", () => {
  it("same mood: ONE thought request, sent BEFORE the router answered — and the turn is byte-for-byte the turn without speculation", async () => {
    const spec = harness({ routerAnswer: "默认", speculativeThought: true });
    const running = spec.driver.runTurn("你好", live());
    await settle();
    // The router has been asked and has not answered; the thought is out.
    expect(spec.routerCalls()).toBe(1);
    expect(spec.calls.map((c) => c.kind)).toEqual(["thought"]);
    expect(spec.calls[0]?.routerReleasedAtStart).toBe(false);
    spec.releaseRouter();
    const record = await running;

    const plain = harness({ routerAnswer: "默认", speculativeThought: false });
    const plainRunning = plain.driver.runTurn("你好", live());
    await settle();
    expect(plain.calls).toEqual([]); // the old order: nothing until the router
    plain.releaseRouter();
    const plainRecord = await plainRunning;

    // Same requests, same record — only the first one's timing moved.
    expect(spec.calls.map((c) => c.kind)).toEqual(["thought", "speech"]);
    expect(spec.calls.map((c) => c.prompt)).toEqual(
      plain.calls.map((c) => c.prompt),
    );
    expect(record).toEqual(plainRecord);
    expect(spec.calls[0]?.signal.aborted).toBe(false);
    expect(plain.calls[0]?.routerReleasedAtStart).toBe(true);
    expect(spec.calls[0]?.prompt).toContain("〔pre-think:默认〕");
  });

  it("changed mood: the guess is CANCELLED and the thought is asked again under the new mood — the turn is the turn without speculation", async () => {
    // The thought is held open, so the guess is still IN FLIGHT when the
    // router answers — a guess that had already finished has nothing left
    // to cancel (and is simply never adopted).
    const spec = harness({
      routerAnswer: "教学版",
      speculativeThought: true,
      gateThought: true,
    });
    const running = spec.driver.runTurn("这个怎么实现？", live());
    await settle();
    spec.releaseRouter();
    await settle();
    spec.releaseThought();
    const record = await running;

    const plain = harness({
      routerAnswer: "教学版",
      speculativeThought: false,
      gateThought: true,
    });
    const plainRunning = plain.driver.runTurn("这个怎么实现？", live());
    await settle();
    plain.releaseRouter();
    await settle();
    plain.releaseThought();
    const plainRecord = await plainRunning;

    expect(spec.calls.map((c) => c.kind)).toEqual([
      "thought",
      "thought",
      "speech",
    ]);
    // The guess ran under the OLD mood and was cancelled, never adopted…
    expect(spec.calls[0]?.prompt).toContain("〔pre-think:默认〕");
    expect(spec.calls[0]?.signal.aborted).toBe(true);
    // …and what the turn actually used is exactly the unspeculated turn.
    expect(spec.calls[1]?.prompt).toContain("〔pre-think:教学版〕");
    expect(spec.calls.slice(1).map((c) => c.prompt)).toEqual(
      plain.calls.map((c) => c.prompt),
    );
    expect(record).toEqual(plainRecord);
    expect(spec.driver.getCurrentIntentState()).toBe("教学版");
  });

  it("the thinking indicator belongs to the ADOPTED thought: nothing reaches the sink before adoption, then one begin and one end", async () => {
    const spec = harness({
      routerAnswer: "默认",
      speculativeThought: true,
      gateThought: true,
    });
    const running = spec.driver.runTurn("你好", live());
    await settle();
    // The speculative thought is already producing — and the screen knows
    // nothing of it: it is not the turn's thought yet.
    expect(spec.calls.map((c) => c.kind)).toEqual(["thought"]);
    expect(spec.sinkLog).toEqual([]);
    spec.releaseRouter();
    await settle();
    expect(spec.sinkLog).toEqual(["begin:thought"]);
    spec.releaseThought();
    await running;
    expect(spec.sinkLog.slice(0, 2)).toEqual(["begin:thought", "end"]);
    expect(spec.sinkLog.filter((l) => l === "begin:thought")).toHaveLength(1);
  });

  it("a cancelled guess never touches the sink", async () => {
    const spec = harness({
      routerAnswer: "教学版",
      speculativeThought: true,
      gateThought: true,
    });
    const running = spec.driver.runTurn("这个怎么实现？", live());
    await settle();
    expect(spec.sinkLog).toEqual([]);
    spec.releaseRouter();
    await settle();
    // Only the REAL thought (call #2) shows; the guess (call #1) is gone.
    expect(spec.calls[0]?.signal.aborted).toBe(true);
    expect(spec.sinkLog).toEqual(["begin:thought"]);
    spec.releaseThought();
    await running;
    expect(spec.sinkLog.filter((l) => l === "begin:thought")).toHaveLength(1);
  });

  it("an interrupt while the router is out cancels the guess too", async () => {
    const spec = harness({
      routerAnswer: "默认",
      speculativeThought: true,
      gateThought: true,
    });
    const abort = new AbortController();
    const running = spec.driver.runTurn("你好", abort.signal);
    await settle();
    expect(spec.calls).toHaveLength(1);
    abort.abort();
    spec.releaseRouter();
    await expect(running).rejects.toBeDefined();
    expect(spec.calls[0]?.signal.aborted).toBe(true);
  });
});

describe("a message that pre-empts a dispatch is not classified", () => {
  it("bare @板砖 + a brief: the router is never asked, the mood is 板砖代答版, 板砖 runs, and nothing is speculated", async () => {
    const h = harness({ routerAnswer: "默认", speculativeThought: true });
    const running = h.driver.runTurn("@板砖 跑一下 npm test", live());
    // No release: if the router were awaited, this would hang.
    const record = await running;
    expect(h.routerCalls()).toBe(0);
    expect(h.briefs()).toBe(1);
    expect(h.driver.getCurrentIntentState()).toBe("板砖代答版");
    // One thought, asked AFTER the run, under the decided mood.
    expect(h.calls.map((c) => c.kind)).toEqual(["thought", "speech"]);
    expect(h.calls[0]?.prompt).toContain("〔pre-think:板砖代答版〕");
    expect(record.some((b) => b.kind === "herta")).toBe(true);
  });

  it("…but a QUOTED `@板砖`, or the bare token with nothing to hand over, is an ordinary message: the router decides", async () => {
    for (const text of ["`@板砖` 是什么？", "@板砖"]) {
      const h = harness({ routerAnswer: "教学版", speculativeThought: false });
      const running = h.driver.runTurn(text, live());
      await settle();
      expect(h.routerCalls(), text).toBe(1);
      h.releaseRouter();
      await running;
      expect(h.briefs(), text).toBe(0);
      expect(h.driver.getCurrentIntentState(), text).toBe("教学版");
    }
  });
});
