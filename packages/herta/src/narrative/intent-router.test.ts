import type {
  ActorPromptFrame,
  ProviderAdapter,
  ProviderEvent,
  TerminalRecord,
} from "@herta/core";
import { describe, expect, it } from "vitest";
import {
  type ClassifyIntentInput,
  classifyIntent,
  lastNSpeechTurns,
  lastNTurnsForSupervisor,
} from "./intent-router.js";
import { MOOD_STATES } from "./meta-think.js";

async function* streamOf(
  events: ProviderEvent[],
): AsyncGenerator<ProviderEvent> {
  for (const e of events) yield e;
}

/**
 * Test fixture: a `ProviderAdapter` whose `streamChat` yields a single
 * text-delta with the given content, then finishes. Captures every
 * frame it was called with in the returned `frames` array so tests can
 * assert on system message + user message content.
 */
function mkRouterProvider(text: string): {
  provider: ProviderAdapter;
  frames: ActorPromptFrame[];
} {
  const frames: ActorPromptFrame[] = [];
  const provider: ProviderAdapter = {
    streamChat(frame, _signal): AsyncIterable<ProviderEvent> {
      // The router only constructs ActorPromptFrame (not BackendPromptFrame),
      // so this cast is safe at the call site.
      frames.push(frame as ActorPromptFrame);
      return streamOf([
        { type: "text-delta", text },
        { type: "finish", reason: "stop" },
      ]);
    },
  };
  return { provider, frames };
}

function baseInput(
  overrides: Partial<ClassifyIntentInput> = {},
): ClassifyIntentInput {
  const { provider } = mkRouterProvider("默认");
  return {
    recentRecord: [
      { kind: "user", text: "hi" },
      { kind: "herta", surface: "speech", text: "在。" },
    ],
    currentState: "默认",
    provider,
    signal: new AbortController().signal,
    ...overrides,
  };
}

describe("classifyIntent — output parsing", () => {
  for (const state of MOOD_STATES) {
    it(`returns state="${state}" when the router emits exactly "${state}"`, async () => {
      const { provider } = mkRouterProvider(state);
      const result = await classifyIntent(
        baseInput({ provider, currentState: "默认" }),
      );
      expect(result.state).toBe(state);
      expect(result.changed).toBe(state !== "默认");
    });
  }

  it("returns currentState with changed=false on '不变'", async () => {
    const { provider } = mkRouterProvider("不变");
    const result = await classifyIntent(
      baseInput({ provider, currentState: "被烦版" }),
    );
    expect(result.state).toBe("被烦版");
    expect(result.changed).toBe(false);
  });

  it("returns currentState with changed=false on unrecognized output", async () => {
    const { provider } = mkRouterProvider("garbage_label");
    const result = await classifyIntent(
      baseInput({ provider, currentState: "教学版" }),
    );
    expect(result.state).toBe("教学版");
    expect(result.changed).toBe(false);
  });

  it("trims whitespace from the router's response before matching", async () => {
    const { provider } = mkRouterProvider("  被顶嘴版  \n");
    const result = await classifyIntent(
      baseInput({ provider, currentState: "默认" }),
    );
    expect(result.state).toBe("被顶嘴版");
    expect(result.changed).toBe(true);
  });

  it("returns currentState when the router emits empty text", async () => {
    const { provider } = mkRouterProvider("");
    const result = await classifyIntent(
      baseInput({ provider, currentState: "默认" }),
    );
    expect(result.state).toBe("默认");
    expect(result.changed).toBe(false);
  });
});

describe("classifyIntent — frame construction", () => {
  it("does NOT include the '不变' escape token in the system message", async () => {
    const { provider, frames } = mkRouterProvider("默认");
    await classifyIntent(baseInput({ provider, currentState: "教学版" }));
    expect(frames).toHaveLength(1);
    expect(frames[0]!.stableSystem).not.toContain("不变");
  });

  it("does NOT include a '当前状态：X' stability anchor in the system message", async () => {
    const { provider, frames } = mkRouterProvider("默认");
    await classifyIntent(baseInput({ provider, currentState: "被烦版" }));
    expect(frames).toHaveLength(1);
    expect(frames[0]!.stableSystem).not.toContain("当前状态");
  });

  it("includes all 7 state labels in the system message", async () => {
    const { provider, frames } = mkRouterProvider("默认");
    await classifyIntent(baseInput({ provider, currentState: "默认" }));
    const sys = frames[0]!.stableSystem;
    for (const s of MOOD_STATES) {
      expect(sys).toContain(s);
    }
  });

  it("includes one trigger example per state (marked with '例：')", async () => {
    const { provider, frames } = mkRouterProvider("默认");
    await classifyIntent(baseInput({ provider, currentState: "默认" }));
    const sys = frames[0]!.stableSystem;
    const exampleCount = (sys.match(/例：/g) ?? []).length;
    expect(exampleCount).toBe(8);
  });

  it("places the serialized recentRecord in the user message, not the system message", async () => {
    const { provider, frames } = mkRouterProvider("默认");
    await classifyIntent(
      baseInput({
        provider,
        currentState: "默认",
        recentRecord: [
          { kind: "user", text: "hello" },
          { kind: "herta", surface: "speech", text: "嗯。" },
        ],
      }),
    );
    const frame = frames[0]!;
    expect(frame.messages).toHaveLength(1);
    const userMsg = frame.messages[0]!;
    expect(userMsg.role).toBe("user");
    // Type narrowing — `role: "user"` messages have `text`.
    if (userMsg.role !== "user") throw new Error("expected user message");
    expect(userMsg.text).toContain("hello");
    expect(userMsg.text).toContain("嗯。");
    expect(userMsg.text).toContain("（开拓者 说）");
    expect(userMsg.text).toContain("（我 说）");
    // The serialized record should NOT appear in the system message —
    // the system message is the stable classifier prompt, independent
    // of the conversation being classified.
    expect(frame.stableSystem).not.toContain("hello");
  });

  it("leaves memoryContext / retrievedLore / toolSchemas empty", async () => {
    const { provider, frames } = mkRouterProvider("默认");
    await classifyIntent(baseInput({ provider, currentState: "默认" }));
    const frame = frames[0]!;
    expect(frame.memoryContext).toBe("");
    expect(frame.retrievedLore).toBe("");
    expect(frame.toolSchemas).toEqual([]);
  });
});

describe("classifyIntent — prompt language (EN interaction slice 3b)", () => {
  it('defaults to the zh classifier prompt (lang omitted ≡ lang:"zh")', async () => {
    const a = mkRouterProvider("默认");
    await classifyIntent(baseInput({ provider: a.provider }));
    const b = mkRouterProvider("默认");
    await classifyIntent(baseInput({ provider: b.provider, lang: "zh" }));
    const defaultSys = a.frames[0]!.stableSystem;
    expect(defaultSys).toBe(b.frames[0]!.stableSystem);
    expect(defaultSys).toContain("你是黑塔对话状态分类器");
    expect(defaultSys).toContain("只输出一个状态名");
  });

  it('lang:"en" system message is English instruction prose that keeps the 7 CN state names', async () => {
    const { provider, frames } = mkRouterProvider("默认");
    await classifyIntent(baseInput({ provider, lang: "en" }));
    const sys = frames[0]!.stableSystem;
    expect(sys).toContain("dialogue-state classifier");
    expect(sys).toContain("Output ONLY the state name, in Chinese");
    // The output vocabulary stays CN — parseRouterOutput matches
    // MOOD_STATES verbatim.
    for (const s of MOOD_STATES) {
      expect(sys).toContain(s);
    }
    // Structural tokens stay CN.
    expect(sys).toContain("（我 想）");
    expect(sys).toContain("（我 说）");
    expect(sys).toContain("@板砖");
    // One English trigger example per state.
    const exampleCount = (sys.match(/e\.g\. /g) ?? []).length;
    expect(exampleCount).toBe(8);
    expect(sys).not.toContain("例：");
  });

  it('lang:"en" user message wraps the same serialized record with English framing', async () => {
    const { provider, frames } = mkRouterProvider("默认");
    await classifyIntent(
      baseInput({
        provider,
        lang: "en",
        recentRecord: [
          { kind: "user", text: "hello" },
          { kind: "herta", surface: "speech", text: "嗯。" },
        ],
      }),
    );
    const userMsg = frames[0]!.messages[0]!;
    if (userMsg.role !== "user") throw new Error("expected user message");
    expect(userMsg.text).toContain("Below is the recent conversation");
    expect(userMsg.text).toContain("output one state name");
    // Record serialization is unchanged — same CN fences.
    expect(userMsg.text).toContain("（开拓者 说）");
    expect(userMsg.text).toContain("hello");
  });

  it('lang:"en" still parses the CN state name the model emits', async () => {
    const { provider } = mkRouterProvider("被顶嘴版");
    const result = await classifyIntent(
      baseInput({ provider, lang: "en", currentState: "默认" }),
    );
    expect(result.state).toBe("被顶嘴版");
    expect(result.changed).toBe(true);
  });
});

describe("classifyIntent — chat-mode tolerance for noisy output", () => {
  it("recognizes a state name followed by punctuation + explanation", async () => {
    // Thinking-mode models occasionally emit `教学版。` plus a brief
    // rationale despite the "不要解释" instruction. The startsWith
    // parser must still recognize the state name at the head.
    const { provider } = mkRouterProvider("教学版。因为开拓者认真问原理。");
    const result = await classifyIntent(
      baseInput({ provider, currentState: "默认" }),
    );
    expect(result.state).toBe("教学版");
    expect(result.changed).toBe(true);
  });

  it("returns currentState when response starts with non-state text", async () => {
    // E.g., the model emits a preamble that doesn't begin with any
    // state name. After trim, no state matches → fallback.
    const { provider } = mkRouterProvider("根据规则，应该是 默认。");
    const result = await classifyIntent(
      baseInput({ provider, currentState: "板砖代答版" }),
    );
    expect(result.state).toBe("板砖代答版"); // fallback to currentState
    expect(result.changed).toBe(false);
  });
});

describe("classifyIntent — signal & errors", () => {
  it("propagates provider errors as a thrown exception", async () => {
    const provider: ProviderAdapter = {
      // biome-ignore lint/correctness/useYield: stub throws before any yield
      async *streamChat(): AsyncIterable<ProviderEvent> {
        throw new Error("router boom");
      },
    } as unknown as ProviderAdapter;
    await expect(classifyIntent(baseInput({ provider }))).rejects.toThrow(
      /boom/,
    );
  });
});

describe("classifyIntent — diagnostic output", () => {
  it("returns the literal system+user prompt bytes via the prompt field", async () => {
    const { provider, frames } = mkRouterProvider("默认");
    const result = await classifyIntent(
      baseInput({ provider, currentState: "默认" }),
    );
    expect(frames).toHaveLength(1);
    const frame = frames[0]!;
    const userMsg = frame.messages[0]!;
    if (userMsg.role !== "user") throw new Error("expected user message");
    // The `prompt` field is system + separator + user, so callers
    // dumping it under HERTA_DUMP_PROMPTS can see both halves.
    expect(result.prompt).toContain(frame.stableSystem);
    expect(result.prompt).toContain(userMsg.text);
    expect(result.prompt).toContain("---USER---");
  });

  it("returns the raw model output verbatim before parsing", async () => {
    const { provider } = mkRouterProvider("  被顶嘴版  \n");
    const result = await classifyIntent(
      baseInput({ provider, currentState: "默认" }),
    );
    expect(result.rawOutput).toBe("  被顶嘴版  \n");
    expect(result.state).toBe("被顶嘴版");
  });

  it("returns empty rawOutput when the provider emits no text", async () => {
    const { provider } = mkRouterProvider("");
    const result = await classifyIntent(
      baseInput({ provider, currentState: "教学版" }),
    );
    expect(result.rawOutput).toBe("");
    expect(result.state).toBe("教学版");
  });
});

describe("lastNSpeechTurns", () => {
  it("keeps only user blocks and herta-speech blocks", () => {
    const record: TerminalRecord = [
      { kind: "user", text: "u1" },
      { kind: "herta", surface: "speech", text: "s1" },
      { kind: "herta", surface: "thought", text: "t1" },
      { kind: "system", label: "系统", body: "read foo" },
      { kind: "user", text: "u2" },
      { kind: "herta", surface: "speech", text: "s2" },
    ];
    const out = lastNSpeechTurns(record, 5);
    expect(out).toEqual([
      { kind: "user", text: "u1" },
      { kind: "herta", surface: "speech", text: "s1" },
      { kind: "user", text: "u2" },
      { kind: "herta", surface: "speech", text: "s2" },
    ]);
  });

  it("caps at N blocks (most recent kept)", () => {
    const record: TerminalRecord = [
      { kind: "user", text: "u1" },
      { kind: "user", text: "u2" },
      { kind: "user", text: "u3" },
      { kind: "user", text: "u4" },
      { kind: "user", text: "u5" },
      { kind: "user", text: "u6" },
    ];
    const out = lastNSpeechTurns(record, 3);
    expect(out).toEqual([
      { kind: "user", text: "u4" },
      { kind: "user", text: "u5" },
      { kind: "user", text: "u6" },
    ]);
  });

  it("returns [] for an empty record", () => {
    expect(lastNSpeechTurns([], 5)).toEqual([]);
  });

  it("returns [] when no blocks pass the filter", () => {
    const record: TerminalRecord = [
      { kind: "herta", surface: "thought", text: "t1" },
      { kind: "system", label: "系统", body: "x" },
    ];
    expect(lastNSpeechTurns(record, 5)).toEqual([]);
  });
});

describe("lastNTurnsForSupervisor", () => {
  it("keeps user + herta-speech + system blocks (drops thoughts)", () => {
    const record: TerminalRecord = [
      { kind: "user", text: "u1" },
      { kind: "herta", surface: "thought", text: "t1" },
      { kind: "herta", surface: "speech", text: "s1" },
      { kind: "system", label: "系统", body: "[文件内容：foo.ts]\nx" },
      { kind: "system", label: "差分协处理器", body: "Reading foo.ts" },
      { kind: "herta", surface: "thought", text: "t2" },
      { kind: "herta", surface: "speech", text: "s2" },
    ];
    const out = lastNTurnsForSupervisor(record, 10);
    expect(out).toEqual([
      { kind: "user", text: "u1" },
      { kind: "herta", surface: "speech", text: "s1" },
      { kind: "system", label: "系统", body: "[文件内容：foo.ts]\nx" },
      { kind: "system", label: "差分协处理器", body: "Reading foo.ts" },
      { kind: "herta", surface: "speech", text: "s2" },
    ]);
  });

  it("keeps only the last N blocks (after filtering)", () => {
    const record: TerminalRecord = [
      { kind: "user", text: "u1" },
      { kind: "herta", surface: "speech", text: "s1" },
      { kind: "system", label: "系统", body: "b1" },
      { kind: "user", text: "u2" },
      { kind: "herta", surface: "speech", text: "s2" },
      { kind: "system", label: "系统", body: "b2" },
    ];
    const out = lastNTurnsForSupervisor(record, 3);
    expect(out).toEqual([
      { kind: "user", text: "u2" },
      { kind: "herta", surface: "speech", text: "s2" },
      { kind: "system", label: "系统", body: "b2" },
    ]);
  });

  it("returns [] for an empty record", () => {
    expect(lastNTurnsForSupervisor([], 5)).toEqual([]);
  });

  it("guards against the bug-1 fabrication scenario (list_files → 系统 → next speech references the listing)", () => {
    // This is the exact failure mode the user reported: turn 1
    // contains `list_files("scripts/")`, the inline tool fires and
    // appends a 系统 block, turn 2 speech references the file from
    // the listing. The supervisor MUST see the 系统 block to
    // judge the reference as grounded rather than fabricated.
    const record: TerminalRecord = [
      { kind: "user", text: "我记得当前目录下面好像有个script文件夹？" },
      {
        kind: "herta",
        surface: "speech",
        text: '对，是有个 scripts 文件夹。直接 list_files("scripts/")',
      },
      {
        kind: "system",
        label: "系统",
        body: "[目录内容：scripts/]\n- scripts/merge-sort.ts",
      },
      {
        kind: "herta",
        surface: "thought",
        text: "他只列了 scripts…（内部规划）",
      },
    ];
    const out = lastNTurnsForSupervisor(record, 5);
    // System block IS present in the supervisor's view, so when the
    // next speech says "scripts/merge-sort.ts 还在", the supervisor
    // can trace that filename to the prior listing.
    const labels = out.map((b) => b.kind);
    expect(labels).toContain("system");
    // The dropped thought is NOT in the supervisor's view (passed
    // separately under `### 我刚才内心想的`).
    expect(
      out.find((b) => b.kind === "herta" && b.surface === "thought"),
    ).toBeUndefined();
  });
});
