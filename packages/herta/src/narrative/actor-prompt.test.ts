import type { TerminalRecord, TerminalRecordBlock } from "@herta/core";
import { describe, expect, it } from "vitest";
import {
  type ActorPrompt,
  type StaticHertaPrefix,
  serializeActorPrompt,
} from "./actor-prompt.js";
import { type AttachedMetaThink, buildMetaThinkSection } from "./meta-think.js";
import { serializeTerminalRecord } from "./serialize.js";

function mkPrefix(
  overrides: Partial<StaticHertaPrefix> = {},
): StaticHertaPrefix {
  return {
    bio: "BIO",
    env: "ENV",
    fewShots: [],
    ...overrides,
  };
}

describe("serializeActorPrompt — static prefix join", () => {
  it("joins bio + env when no few-shots and no opening", () => {
    const prompt: ActorPrompt = {
      staticPrefix: mkPrefix(),
      record: [],
      priorTurnLength: 0,
      openTag: "",
    };
    expect(serializeActorPrompt(prompt)).toBe("BIO\n\nENV");
  });
});

describe("serializeActorPrompt — static prefix join (more cases)", () => {
  it("interleaves few-shots between bio and env in order", () => {
    const prompt: ActorPrompt = {
      staticPrefix: mkPrefix({ fewShots: ["FS1", "FS2"] }),
      record: [],
      priorTurnLength: 0,
      openTag: "",
    };
    expect(serializeActorPrompt(prompt)).toBe("BIO\n\nFS1\n\nFS2\n\nENV");
  });

  it("appends opening with the `### 此刻` header after env", () => {
    const prompt: ActorPrompt = {
      staticPrefix: mkPrefix({ opening: "preamble text" }),
      record: [],
      priorTurnLength: 0,
      openTag: "",
    };
    expect(serializeActorPrompt(prompt)).toBe(
      "BIO\n\nENV\n\n### 此刻\n\npreamble text",
    );
  });
});

describe("serializeActorPrompt — record body", () => {
  it("serializes a simple record with no attachment", () => {
    const prompt: ActorPrompt = {
      staticPrefix: mkPrefix(),
      record: [
        { kind: "user", text: "hi" },
        { kind: "herta", surface: "speech", text: "在。" },
      ],
      priorTurnLength: 0,
      openTag: "（我 想）",
    };
    const out = serializeActorPrompt(prompt);
    expect(out).toContain("（开拓者 说）");
    expect(out).toContain("hi");
    expect(out).toContain("（我 说）");
    expect(out).toContain("在。");
    expect(out.endsWith("（我 想）\n")).toBe(true);
  });

  it("drops prior-turn herta-thought blocks via the filter", () => {
    const prompt: ActorPrompt = {
      staticPrefix: mkPrefix(),
      record: [
        { kind: "user", text: "u1" },
        { kind: "herta", surface: "thought", text: "PRIOR_THOUGHT_BODY" },
        { kind: "herta", surface: "speech", text: "s1" },
        { kind: "user", text: "u2" },
      ],
      // priorTurnLength = 3 → blocks at indices 0,1,2 are prior; index 1
      // (the herta-thought) gets filtered out.
      priorTurnLength: 3,
      openTag: "（我 想）",
    };
    const out = serializeActorPrompt(prompt);
    expect(out).not.toContain("PRIOR_THOUGHT_BODY");
    expect(out).toContain("u1");
    expect(out).toContain("s1");
    expect(out).toContain("u2");
  });

  it("keeps a same-turn in-flight thought (no following speech)", () => {
    // Record: user + thought. No speech follows the thought yet.
    // The thought is in-flight — it must appear in the prompt so the
    // model can generate its speech grounded on that reasoning.
    const prompt: ActorPrompt = {
      staticPrefix: mkPrefix(),
      record: [
        { kind: "user", text: "u1" },
        { kind: "herta", surface: "thought", text: "INFLIGHT" },
      ],
      priorTurnLength: 0,
      openTag: "（我 说）",
    };
    const out = serializeActorPrompt(prompt);
    expect(out).toContain("INFLIGHT");
  });

  it("drops a same-turn thought once its speech is committed", () => {
    // Record: user + thought + speech. The thought's speech has been
    // committed — the thought is consumed and must be dropped from the
    // prompt. The speech must remain.
    const prompt: ActorPrompt = {
      staticPrefix: mkPrefix(),
      record: [
        { kind: "user", text: "u1" },
        { kind: "herta", surface: "thought", text: "SPOKEN" },
        { kind: "herta", surface: "speech", text: "s1" },
      ],
      priorTurnLength: 0,
      openTag: "（我 想）",
    };
    const out = serializeActorPrompt(prompt);
    expect(out).not.toContain("SPOKEN");
    expect(out).toContain("s1");
  });

  it("multi-iteration: thought before first speech is dropped; subsequent speech is kept", () => {
    // Mirrors a turn-030 scenario: user, thought T1, speech S1@plate, system
    // block, speech S2beat. The thought T1 has speech (S1) after it, so it
    // is dropped. Both speech blocks survive.
    const prompt: ActorPrompt = {
      staticPrefix: mkPrefix(),
      record: [
        { kind: "user", text: "u1" },
        { kind: "herta", surface: "thought", text: "T1" },
        { kind: "herta", surface: "speech", text: "S1@plate" },
        {
          kind: "system",
          label: "系统",
          body: "tool output",
        },
        { kind: "herta", surface: "speech", text: "S2beat" },
      ],
      priorTurnLength: 0,
      openTag: "（我 想）",
    };
    const out = serializeActorPrompt(prompt);
    expect(out).not.toContain("T1");
    expect(out).toContain("S1@plate");
    expect(out).toContain("S2beat");
  });
});

describe("serializeActorPrompt — meta-think splice", () => {
  function mkAttachment(
    overrides: Partial<AttachedMetaThink> = {},
  ): AttachedMetaThink {
    return {
      state: "默认",
      beforeThinkIndex: 1,
      beforeSpeakIndex: 2,
      preThinkText: "THINK_TXT",
      preSpeakText: "SPEAK_TXT",
      ...overrides,
    };
  }

  it("for thought surface: splices preThinkText at beforeThinkIndex", () => {
    const prompt: ActorPrompt = {
      staticPrefix: mkPrefix(),
      record: [{ kind: "user", text: "hi" }],
      priorTurnLength: 0,
      attachedMetaThink: mkAttachment(),
      metaThinkSurface: "thought",
      openTag: "（我 想）",
    };
    const out = serializeActorPrompt(prompt);
    expect(out).toContain("THINK_TXT");
    expect(out).not.toContain("SPEAK_TXT");
    // Order: user-block → meta-think section → open tag.
    const userPos = out.indexOf("（/开拓者 说）");
    const sectionPos = out.indexOf("THINK_TXT");
    const openTagPos = out.lastIndexOf("（我 想）");
    expect(sectionPos).toBeGreaterThan(userPos);
    expect(openTagPos).toBeGreaterThan(sectionPos);
  });

  it("for thought surface with beforeThinkIndex = 0: splices section BEFORE the user block (driver's default placement)", () => {
    const prompt: ActorPrompt = {
      staticPrefix: mkPrefix(),
      record: [{ kind: "user", text: "hi" }],
      priorTurnLength: 0,
      attachedMetaThink: mkAttachment({ beforeThinkIndex: 0 }),
      metaThinkSurface: "thought",
      openTag: "（我 想）",
    };
    const out = serializeActorPrompt(prompt);
    expect(out).toContain("THINK_TXT");
    // Order: meta-think section → user-block → open tag. This is
    // the layout the driver produces with `beforeThinkIndex =
    // record.length` (= position of the incoming user message).
    const sectionPos = out.indexOf("THINK_TXT");
    const userPos = out.indexOf("（/开拓者 说）");
    const openTagPos = out.lastIndexOf("（我 想）");
    expect(sectionPos).toBeLessThan(userPos);
    expect(userPos).toBeLessThan(openTagPos);
  });

  it("for speech surface: splices preSpeakText at beforeSpeakIndex (after thought)", () => {
    const prompt: ActorPrompt = {
      staticPrefix: mkPrefix(),
      record: [
        { kind: "user", text: "hi" },
        { kind: "herta", surface: "thought", text: "想想看" },
      ],
      priorTurnLength: 0,
      attachedMetaThink: mkAttachment(),
      metaThinkSurface: "speech",
      openTag: "（我 说）",
    };
    const out = serializeActorPrompt(prompt);
    expect(out).toContain("SPEAK_TXT");
    expect(out).not.toContain("THINK_TXT");
    // Order: user → thought-body → meta-speak section → open tag.
    const thoughtBody = out.indexOf("想想看");
    const sectionPos = out.indexOf("SPEAK_TXT");
    const openTagPos = out.lastIndexOf("（我 说）");
    expect(sectionPos).toBeGreaterThan(thoughtBody);
    expect(openTagPos).toBeGreaterThan(sectionPos);
  });

  it("emits no preamble when the surface text is empty", () => {
    const prompt: ActorPrompt = {
      staticPrefix: mkPrefix(),
      record: [{ kind: "user", text: "hi" }],
      priorTurnLength: 0,
      attachedMetaThink: mkAttachment({ preThinkText: "" }),
      metaThinkSurface: "thought",
      openTag: "（我 想）",
    };
    const out = serializeActorPrompt(prompt);
    // No leftover heading markers (the older design wrapped the text
    // in `## 注释` / `## 注释完`; this is now bare preamble, and an
    // empty preamble means nothing at all gets injected).
    expect(out).not.toContain("## 注释");
    // Body collapses to user-block → open-tag with only standard
    // inter-section separators.
    expect(out).toMatch(/（\/开拓者 说）\n\n（我 想）\n$/);
  });

  it("appends section at the end when the splice index is past the filtered record", () => {
    const prompt: ActorPrompt = {
      staticPrefix: mkPrefix(),
      record: [{ kind: "user", text: "hi" }],
      priorTurnLength: 0,
      // beforeThinkIndex = 99 is way past record.length (= 1).
      attachedMetaThink: mkAttachment({ beforeThinkIndex: 99 }),
      metaThinkSurface: "thought",
      openTag: "（我 想）",
    };
    const out = serializeActorPrompt(prompt);
    // The section should sit at the end of the record body, just
    // before the trailing open tag.
    const sectionPos = out.indexOf("THINK_TXT");
    const openTagPos = out.lastIndexOf("（我 想）");
    const userClosePos = out.indexOf("（/开拓者 说）");
    expect(sectionPos).toBeGreaterThan(userClosePos);
    expect(openTagPos).toBeGreaterThan(sectionPos);
  });

  it("filters prior-turn thoughts BEFORE mapping the splice index to filtered space", async () => {
    // Production scenario: turn 2+ — `record` contains a completed
    // prior turn (user, thought, speech) plus the current turn's
    // user block. `priorTurnLength = 3` so the thought at index 1
    // is dropped from the serialized prompt. The attachment was
    // created on turn 1 with `beforeThinkIndex = 1` (the position
    // where turn-1's thought block would land in the FULL record).
    //
    // After filtering, that full-record index 1 maps to filtered-
    // record position 1 (since index 0 = user-1 is kept and index 1
    // = thought-1 is dropped, so the loop counts 1 surviving block
    // up to but not including position 1).
    const prompt: ActorPrompt = {
      staticPrefix: mkPrefix(),
      record: [
        { kind: "user", text: "u1" },
        { kind: "herta", surface: "thought", text: "DROPPED_THOUGHT" },
        { kind: "herta", surface: "speech", text: "s1" },
        { kind: "user", text: "u2" },
      ],
      priorTurnLength: 3,
      attachedMetaThink: mkAttachment({ beforeThinkIndex: 1 }),
      metaThinkSurface: "thought",
      openTag: "（我 想）",
    };
    const out = serializeActorPrompt(prompt);
    // The dropped thought body is absent.
    expect(out).not.toContain("DROPPED_THOUGHT");
    // The meta-think section appears, and crucially it splices
    // AFTER the user-1 block (which survived filtering) but BEFORE
    // speech-1 (which also survived). If the index mapping were
    // wrong — e.g., if the loop did not skip prior-turn thoughts —
    // the section would land between speech-1 and user-2 instead.
    const u1Close = out.indexOf("（/开拓者 说）");
    const sectionPos = out.indexOf("THINK_TXT");
    const s1Body = out.indexOf("s1");
    expect(u1Close).toBeGreaterThanOrEqual(0);
    expect(sectionPos).toBeGreaterThan(u1Close);
    expect(s1Body).toBeGreaterThan(sectionPos);
  });
});

describe("serializeActorPrompt — format hint + open tag tail", () => {
  it("inserts format hint between the body and the open tag (separated by `\\n`)", () => {
    const prompt: ActorPrompt = {
      staticPrefix: mkPrefix(),
      record: [{ kind: "user", text: "hi" }],
      priorTurnLength: 0,
      formatHint: "〔HINT〕",
      openTag: "（我 想）",
    };
    expect(serializeActorPrompt(prompt).endsWith("〔HINT〕\n（我 想）\n")).toBe(
      true,
    );
  });

  it("omits the hint cleanly when not provided", () => {
    const prompt: ActorPrompt = {
      staticPrefix: mkPrefix(),
      record: [{ kind: "user", text: "hi" }],
      priorTurnLength: 0,
      openTag: "（我 想）",
    };
    expect(
      serializeActorPrompt(prompt).endsWith("（/开拓者 说）\n\n（我 想）\n"),
    ).toBe(true);
  });
});

describe("serializeActorPrompt — replayBlock", () => {
  it("inserts replayBlock between the record and the format hint", () => {
    const prompt: ActorPrompt = {
      staticPrefix: mkPrefix(),
      record: [{ kind: "user", text: "hi" }],
      priorTurnLength: 0,
      replayBlock: "（我 说）\n好。\n（/我 说）",
      formatHint: "〔REVISE〕",
      openTag: "（我 说）",
    };
    const serialized = serializeActorPrompt(prompt);
    expect(serialized).toContain("（我 说）\n好。\n（/我 说）");
    // Order: record → replayBlock → formatHint → openTag.
    const userIdx = serialized.indexOf("hi");
    const replayIdx = serialized.indexOf("（我 说）\n好。\n（/我 说）");
    const hintIdx = serialized.indexOf("〔REVISE〕");
    expect(userIdx).toBeLessThan(replayIdx);
    expect(replayIdx).toBeLessThan(hintIdx);
  });

  it("omits replayBlock cleanly when not provided", () => {
    const prompt: ActorPrompt = {
      staticPrefix: mkPrefix(),
      record: [{ kind: "user", text: "hi" }],
      priorTurnLength: 0,
      formatHint: "〔H〕",
      openTag: "（我 说）",
    };
    expect(serializeActorPrompt(prompt)).not.toContain("（/我 说）");
  });

  it("omits replayBlock cleanly when set to empty string", () => {
    const prompt: ActorPrompt = {
      staticPrefix: mkPrefix(),
      record: [{ kind: "user", text: "hi" }],
      priorTurnLength: 0,
      replayBlock: "",
      formatHint: "〔H〕",
      openTag: "（我 说）",
    };
    // No extra blank-line block from an empty replayBlock.
    expect(serializeActorPrompt(prompt)).toBe(
      `BIO\n\nENV\n\n（开拓者 说）\nhi\n（/开拓者 说）\n\n〔H〕\n（我 说）\n`,
    );
  });
});

describe("serializeActorPrompt — compactBridgeOutput threading (compaction, 2026-05-24)", () => {
  function reading(path: string): TerminalRecordBlock {
    return {
      kind: "system",
      label: "差分协处理器",
      body: `Reading {"path":"${path}"}`,
    };
  }

  it("applies compaction by default (compactBridgeOutput omitted)", () => {
    const prompt: ActorPrompt = {
      staticPrefix: mkPrefix(),
      record: [
        { kind: "user", text: "改一下" },
        reading("a.ts"),
        reading("b.ts"),
      ],
      priorTurnLength: 0,
      openTag: "（我 说）",
    };
    const out = serializeActorPrompt(prompt);
    expect(out).toContain("板砖之前做过的事（细节不在手边）：");
    expect(out).toContain("- Reading a.ts, b.ts");
    expect(out).not.toContain('Reading {"path":"a.ts"}');
  });

  it("passes the raw run through when ActorPrompt.compactBridgeOutput is false", () => {
    const prompt: ActorPrompt = {
      staticPrefix: mkPrefix(),
      record: [{ kind: "user", text: "x" }, reading("a.ts"), reading("b.ts")],
      priorTurnLength: 0,
      openTag: "（我 说）",
      compactBridgeOutput: false,
    };
    const out = serializeActorPrompt(prompt);
    expect(out).not.toContain("板砖之前做过的事（细节不在手边）：");
    expect(out).toContain('Reading {"path":"a.ts"}');
    expect(out).toContain('Reading {"path":"b.ts"}');
  });

  it("run-snap: a meta-think splice inside a system run does not split the run's compaction (M-projection-2)", () => {
    // beforeSpeakIndex 2 lands BETWEEN the two Reading blocks. Pre-fix,
    // the before/after halves were compacted independently, cutting the
    // run in two singletons — raw Reading JSON leaked into the prompt
    // where one [历史已压缩] summary belongs. The splice now snaps back to
    // the run's first block, so the section precedes the intact run.
    const prompt: ActorPrompt = {
      staticPrefix: mkPrefix(),
      record: [
        { kind: "user", text: "改一下" },
        reading("a.ts"),
        reading("b.ts"),
        { kind: "herta", surface: "speech", text: "看完了。" },
      ],
      priorTurnLength: 0,
      attachedMetaThink: {
        state: "默认",
        beforeThinkIndex: 2,
        beforeSpeakIndex: 2,
        preThinkText: "THINK_TXT",
        preSpeakText: "SPEAK_TXT",
      },
      metaThinkSurface: "speech",
      openTag: "（我 说）",
    };
    const out = serializeActorPrompt(prompt);
    // The run compacts as ONE summary, same as the unspliced projection.
    expect(out).toContain("板砖之前做过的事（细节不在手边）：");
    expect(out).toContain("- Reading a.ts, b.ts");
    expect(out).not.toContain('Reading {"path":"a.ts"}');
    // The section lands before the (whole) run.
    expect(out.indexOf("SPEAK_TXT")).toBeLessThan(
      out.indexOf("板砖之前做过的事（细节不在手边）："),
    );
  });
});

describe("serializeActorPrompt — recap (compaction)", () => {
  it("renders the recap after the prefix and drops pre-boundary blocks", () => {
    const out = serializeActorPrompt({
      staticPrefix: { bio: "我是黑塔。", env: "", fewShots: [] },
      record: [
        { kind: "user", text: "旧问题" },
        { kind: "herta", surface: "speech", text: "旧回答" },
        { kind: "user", text: "新问题" },
      ],
      priorTurnLength: 3,
      recap: "我记得开拓者问过我一些旧事。",
      recapBoundaryIndex: 2,
      openTag: "（我 说）",
    });
    expect(out).toContain("### 记录：先前");
    expect(out).toContain("我记得开拓者问过我一些旧事。");
    expect(out).toContain("新问题");
    expect(out).not.toContain("旧问题");
  });

  it("is unchanged (no recap header) when recap is absent", () => {
    const out = serializeActorPrompt({
      staticPrefix: { bio: "我是黑塔。", env: "", fewShots: [] },
      record: [{ kind: "user", text: "问" }],
      priorTurnLength: 1,
      openTag: "（我 说）",
    });
    expect(out).not.toContain("### 记录：先前");
    expect(out).toContain("问");
  });
});

describe("serializeActorPrompt — long-record equivalence vs naive reference (perf pass 2026-07-16)", () => {
  // keepInPrompt's spoken-after decision moved from an O(n) forward
  // `record.some` per thought block (quadratic per projection, since
  // thought blocks stay in the in-memory record as sessions grow) to ONE
  // hoisted last-speech index computed with a backward walk that stops at
  // the first speech from the tail. The serialized prompt must be
  // byte-for-byte unchanged for EVERY record shape. The reference below
  // re-implements the filter and the splice-index mapping loop with the
  // pre-optimization forward scan, composed from the same production
  // primitives the optimized path uses (serializeTerminalRecord,
  // buildMetaThinkSection) — any divergence isolates to the hoisted walk.

  function referenceKeepInPrompt(
    block: TerminalRecordBlock,
    idx: number,
    record: TerminalRecord,
    priorTurnLength: number,
  ): boolean {
    if (!(block.kind === "herta" && block.surface === "thought")) return true;
    if (idx < priorTurnLength) return false;
    const spokenAfter = record.some(
      (b, j) => j > idx && b.kind === "herta" && b.surface === "speech",
    );
    return !spokenAfter;
  }

  const serializeOpts = {
    compressDiffs: true,
    compactBridgeOutput: true,
    verbatimSinceLastDispatch: false,
  };

  // Pre-optimization serializeRecordWithAttachment, verbatim, with the
  // naive filter at both call sites (the record filter and the splice-
  // index mapping loop).
  function referenceRecordBody(opts: {
    record: TerminalRecord;
    priorTurnLength: number;
    attachedMetaThink?: AttachedMetaThink;
    surface?: "thought" | "speech";
    boundary: number;
  }): string {
    const filtered = opts.record.filter(
      (block, idx) =>
        idx >= opts.boundary &&
        referenceKeepInPrompt(block, idx, opts.record, opts.priorTurnLength),
    );
    const attached = opts.attachedMetaThink;
    if (attached === undefined || opts.surface === undefined) {
      return serializeTerminalRecord(filtered, serializeOpts);
    }
    const text =
      opts.surface === "thought"
        ? attached.preThinkText
        : attached.preSpeakText;
    const section = buildMetaThinkSection(text);
    if (section.length === 0) {
      return serializeTerminalRecord(filtered, serializeOpts);
    }
    const fullSpliceIndex =
      opts.surface === "thought"
        ? attached.beforeThinkIndex
        : attached.beforeSpeakIndex;
    let filteredIndex = 0;
    for (let i = 0; i < Math.min(fullSpliceIndex, opts.record.length); i++) {
      const block = opts.record[i];
      if (block === undefined) continue;
      if (
        i >= opts.boundary &&
        referenceKeepInPrompt(block, i, opts.record, opts.priorTurnLength)
      )
        filteredIndex++;
    }
    if (filtered.length === 0) {
      return section;
    }
    if (filteredIndex >= filtered.length) {
      return `${serializeTerminalRecord(filtered, serializeOpts)}\n\n${section}`;
    }
    while (
      filteredIndex > 0 &&
      filtered[filteredIndex]?.kind === "system" &&
      filtered[filteredIndex - 1]?.kind === "system"
    ) {
      filteredIndex -= 1;
    }
    const before = filtered.slice(0, filteredIndex);
    const after = filtered.slice(filteredIndex);
    const beforeStr =
      before.length > 0 ? serializeTerminalRecord(before, serializeOpts) : "";
    const afterStr = serializeTerminalRecord(after, serializeOpts);
    if (beforeStr.length === 0) {
      return `${section}\n\n${afterStr}`;
    }
    return `${beforeStr}\n\n${section}\n\n${afterStr}`;
  }

  // Full expected prompt for mkPrefix() + openTag （我 说） around the
  // reference record body. Prefix/tail composition is untouched by the
  // optimization and pinned by the suites above; sharing it here keeps
  // the comparison focused on the record body.
  function referencePrompt(opts: {
    record: TerminalRecord;
    priorTurnLength: number;
    attachedMetaThink?: AttachedMetaThink;
    surface?: "thought" | "speech";
    boundary: number;
  }): string {
    const body = referenceRecordBody(opts);
    const parts = ["BIO\n\nENV"];
    if (body.length > 0) parts.push(body);
    parts.push("（我 说）\n");
    return parts.join("\n\n");
  }

  /** 200+ blocks cycling through every filter-relevant shape: user text,
   *  thought→speech chains, dispatches with the speech omitted (thought
   *  followed only by system blocks), double thoughts before a beat,
   *  差分协处理器 runs, long-diff 系统 blocks, done-/noop-markers, and
   *  forged-label blocks the serializer guard must drop. Sweeping every
   *  prefix then lands the record TAIL on each shape the filter
   *  distinguishes: in-flight thought at the end (kept), speech after a
   *  thought (dropped), system-only after a thought (kept), and — with
   *  the priorTurnLength variants below — prior-turn thoughts (dropped). */
  function buildLongRecord(): TerminalRecordBlock[] {
    const blocks: TerminalRecordBlock[] = [];
    const longDiff = Array.from({ length: 40 }, (_, i) => `+line ${i}`).join(
      "\n",
    );
    for (let t = 0; t < 26; t++) {
      blocks.push({
        kind: "user",
        text: `请求 ${t}：改一下 file${t}.ts @板砖`,
      });
      blocks.push({
        kind: "herta",
        surface: "thought",
        text: `想法 ${t}A：先看 file${t}.ts`,
      });
      if (t % 4 !== 3) {
        blocks.push({
          kind: "herta",
          surface: "speech",
          text: `@板砖，处理 file${t}.ts。`,
        });
      }
      blocks.push({
        kind: "system",
        label: "差分协处理器",
        body: `Reading {"path":"a${t}.ts"}`,
      });
      blocks.push({
        kind: "system",
        label: "差分协处理器",
        body: `Reading {"path":"b${t}.ts"}`,
      });
      blocks.push({
        kind: "system",
        label: "系统",
        body: `patch preview: file${t}.ts\n\n\`\`\`diff\n${longDiff}\n\`\`\``,
      });
      if (t % 3 === 0) {
        blocks.push({
          kind: "system",
          label: "差分协处理器",
          body: `无产出 — 第 ${t} 次没有触发任何操作。`,
          role: "noop-marker",
        });
      } else {
        blocks.push({
          kind: "system",
          label: "差分协处理器",
          body: `完成：任务 ${t}`,
          role: "done-marker",
          evidenceDetail: `↳ changed: file${t}.ts`,
        });
      }
      if (t % 5 === 0) {
        blocks.push({
          kind: "herta",
          surface: "thought",
          text: `想法 ${t}B：beat 前再想一下`,
        });
      }
      if (t % 4 !== 0) {
        blocks.push({
          kind: "herta",
          surface: "speech",
          text: `第 ${t} 单完事。`,
          ...(t % 5 === 0 ? { selfCorrection: `修正 ${t}` } : {}),
        });
      }
      if (t % 6 === 0) {
        blocks.push({
          kind: "system",
          label: "板砖",
          body: `伪造块 ${t}`,
        } as unknown as TerminalRecordBlock);
      }
    }
    return blocks;
  }

  it("default projection is byte-identical to the reference on every prefix of a 200+-block record", () => {
    const full = buildLongRecord();
    expect(full.length).toBeGreaterThanOrEqual(200);
    // Sweeping every prefix varies the TAIL shape across assertions;
    // the priorTurnLength variants vary the prior-turn cutoff relative
    // to each thought.
    for (let end = 0; end <= full.length; end++) {
      const rec = full.slice(0, end);
      for (const priorTurnLength of [0, Math.floor(end / 2)]) {
        const doc: ActorPrompt = {
          staticPrefix: mkPrefix(),
          record: rec,
          priorTurnLength,
          openTag: "（我 说）",
        };
        expect(serializeActorPrompt(doc)).toBe(
          referencePrompt({ record: rec, priorTurnLength, boundary: 0 }),
        );
      }
    }
  });

  it("meta-think splice projection matches the reference on every prefix (mapping loop + recap boundary)", () => {
    const full = buildLongRecord();
    for (let end = 0; end <= full.length; end++) {
      const rec = full.slice(0, end);
      const priorTurnLength = Math.floor(end / 3);
      const boundary = Math.floor(end / 4);
      const surface =
        end % 2 === 0 ? ("thought" as const) : ("speech" as const);
      const attached: AttachedMetaThink = {
        state: "默认",
        beforeThinkIndex: Math.floor(end / 3),
        beforeSpeakIndex: Math.floor((end * 2) / 3),
        preThinkText: "THINK_TXT",
        preSpeakText: "SPEAK_TXT",
      };
      const doc: ActorPrompt = {
        staticPrefix: mkPrefix(),
        record: rec,
        priorTurnLength,
        attachedMetaThink: attached,
        metaThinkSurface: surface,
        recapBoundaryIndex: boundary,
        openTag: "（我 说）",
      };
      expect(serializeActorPrompt(doc)).toBe(
        referencePrompt({
          record: rec,
          priorTurnLength,
          attachedMetaThink: attached,
          surface,
          boundary,
        }),
      );
    }
  });
});

describe("serializeActorPrompt — cache discipline (the static prefix is the stable head)", () => {
  // The static prefix is the ONE guaranteed cache-stable region: frozen at
  // session start, it must always be the byte-identical head of the prompt so
  // the provider's prompt cache hits it every turn. Everything after it (recap,
  // record body, tail) is deliberately dynamic. These guard the invariant.
  const prefix = mkPrefix({ fewShots: ["FS1", "FS2"], opening: "preamble" });
  const staticHead = serializeActorPrompt({
    staticPrefix: prefix,
    record: [],
    priorTurnLength: 0,
    openTag: "",
  });

  it("the computed static head is non-empty (so the guards below are meaningful)", () => {
    expect(staticHead.length).toBeGreaterThan(0);
    expect(staticHead).toBe("BIO\n\nFS1\n\nFS2\n\nENV\n\n### 此刻\n\npreamble");
  });

  it("emits the static prefix as the byte-for-byte head of the prompt", () => {
    const out = serializeActorPrompt({
      staticPrefix: prefix,
      record: [{ kind: "user", text: "在吗" }],
      priorTurnLength: 0,
      openTag: "（我 说）",
    });
    expect(out.startsWith(staticHead)).toBe(true);
  });

  it("preserves the static-prefix head byte-for-byte as the record grows across turns", () => {
    const turnN = serializeActorPrompt({
      staticPrefix: prefix,
      record: [
        { kind: "user", text: "一" },
        { kind: "herta", surface: "speech", text: "第一次。" },
      ],
      priorTurnLength: 0,
      openTag: "（我 说）",
    });
    const turnNext = serializeActorPrompt({
      staticPrefix: prefix,
      record: [
        { kind: "user", text: "一" },
        { kind: "herta", surface: "speech", text: "第一次。" },
        { kind: "user", text: "二" },
        { kind: "herta", surface: "speech", text: "第二次。" },
      ],
      priorTurnLength: 0,
      openTag: "（我 说）",
    });
    // Appending blocks only appends — the static-prefix head is identical, so
    // the cache hits it on every turn.
    expect(turnN.startsWith(staticHead)).toBe(true);
    expect(turnNext.startsWith(staticHead)).toBe(true);
  });

  it("the static prefix does not depend on the record, the open tag, or the thought cutoff", () => {
    const a = serializeActorPrompt({
      staticPrefix: prefix,
      record: [{ kind: "user", text: "x" }],
      priorTurnLength: 0,
      openTag: "（我 说）",
    });
    const b = serializeActorPrompt({
      staticPrefix: prefix,
      record: [
        { kind: "user", text: "y" },
        { kind: "system", label: "差分协处理器", body: "Reading a.ts" },
      ],
      priorTurnLength: 1,
      openTag: "（我 想）",
    });
    expect(a.startsWith(staticHead)).toBe(true);
    expect(b.startsWith(staticHead)).toBe(true);
  });
});
