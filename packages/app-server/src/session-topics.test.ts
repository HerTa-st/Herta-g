import type { SessionTopic, TerminalRecord } from "@herta/core";
import { describe, expect, it } from "vitest";
import {
  appendTopic,
  pruneTopics,
  renameCurrentTopic,
  synthesizeInitialTopic,
  TOPIC_ANCHOR_TEXT_MAX,
  TOPIC_HISTORY_CAP,
  topicAnchorText,
} from "./session-topics.js";

function topic(title: string, anchorIndex: number): SessionTopic {
  return { title, anchorIndex, anchorText: `m${anchorIndex}`, at: "t" };
}

describe("topicAnchorText", () => {
  it("flattens whitespace and truncates with an ellipsis", () => {
    expect(topicAnchorText("first\n\n  second")).toBe("first second");
    const long = "长".repeat(TOPIC_ANCHOR_TEXT_MAX + 10);
    const cut = topicAnchorText(long);
    expect(cut.endsWith("…")).toBe(true);
    expect(cut.length).toBe(TOPIC_ANCHOR_TEXT_MAX + 1);
  });
});

describe("appendTopic", () => {
  it("appends a CHANGED title as a new topic", () => {
    const next = appendTopic([topic("A", 0)], topic("B", 6));
    expect(next?.map((t) => t.title)).toEqual(["A", "B"]);
  });

  it("returns null when the retitle re-derived the SAME title (no boundary)", () => {
    expect(appendTopic([topic("A", 0)], topic("A", 6))).toBeNull();
  });

  it("the first title always appends (empty history)", () => {
    expect(appendTopic([], topic("A", 0))?.map((t) => t.title)).toEqual(["A"]);
  });

  it("caps the history, dropping the oldest", () => {
    const full = Array.from({ length: TOPIC_HISTORY_CAP }, (_, i) =>
      topic(`T${i}`, i),
    );
    const next = appendTopic(full, topic("NEW", 999));
    expect(next).toHaveLength(TOPIC_HISTORY_CAP);
    expect(next?.[0]?.title).toBe("T1");
    expect(next?.[next.length - 1]?.title).toBe("NEW");
  });
});

describe("pruneTopics", () => {
  it("drops topics anchored beyond the truncated record", () => {
    const topics = [topic("A", 0), topic("B", 6), topic("C", 12)];
    expect(pruneTopics(topics, 7).map((t) => t.title)).toEqual(["A", "B"]);
  });

  it("returns the SAME reference when nothing changed", () => {
    const topics = [topic("A", 0)];
    expect(pruneTopics(topics, 5)).toBe(topics);
  });

  it("drops a topic BORN in the withdrawn turn, even when its anchor survives", () => {
    // The reported bug (user 2026-07-30), at its real geometry. A session
    // resumed hours later: the re-entry retitle windows over the last two
    // exchanges, so the NEW topic anchors at the OLD user block (index 0) —
    // which the rewind does not touch. Anchor-liveness alone therefore kept
    // it and the rail still showed two ticks for one surviving topic.
    const old = { ...topic("昨天的话题", 0), bornAtLength: 2 };
    const fresh = { ...topic("新话题", 0), bornAtLength: 4 };
    // Rewinding the new turn takes the record back to length 2.
    expect(pruneTopics([old, fresh], 2).map((t) => t.title)).toEqual([
      "昨天的话题",
    ]);
    // Before the rewind both are alive.
    expect(pruneTopics([old, fresh], 4)).toHaveLength(2);
  });

  it("keeps a topic born exactly at the current length", () => {
    // Off-by-one guard: `bornAtLength` is the length AFTER its turn landed, so
    // a record still that long has not withdrawn anything.
    const t = { ...topic("A", 0), bornAtLength: 4 };
    expect(pruneTopics([t], 4)).toHaveLength(1);
    expect(pruneTopics([t], 3)).toHaveLength(0);
  });

  it("judges pre-2026-07-30 entries (no bornAtLength) on the anchor alone", () => {
    const legacy = [topic("A", 0), topic("B", 6)];
    expect(pruneTopics(legacy, 7).map((t) => t.title)).toEqual(["A", "B"]);
    expect(pruneTopics(legacy, 6).map((t) => t.title)).toEqual(["A"]);
  });
});

describe("renameCurrentTopic (ADR 0072 §3, owner 2026-09-30)", () => {
  const record: TerminalRecord = [
    { kind: "herta", surface: "speech", text: "开场白" },
    { kind: "user", text: "第一条消息", at: "2026-07-12T00:00:00.000Z" },
  ];
  const topics: SessionTopic[] = [
    { title: "第一个", anchorIndex: 1, anchorText: "a", at: "t1" },
    {
      title: "当前的",
      anchorIndex: 9,
      anchorText: "b",
      at: "t2",
      bornAtLength: 12,
    },
  ];

  it("renames the last topic only — its anchor, text and birth stay", () => {
    expect(renameCurrentTopic(topics, "新名字", record)).toEqual([
      topics[0],
      { ...topics[1], title: "新名字" },
    ]);
  });

  it("with no topics, makes the first from the name at the first message", () => {
    expect(renameCurrentTopic([], "新名字", record)).toEqual([
      {
        title: "新名字",
        anchorIndex: 1,
        anchorText: "第一条消息",
        at: "2026-07-12T00:00:00.000Z",
      },
    ]);
  });

  it("with no topics and no message, has none to rename", () => {
    expect(renameCurrentTopic([], "新名字", [])).toEqual([]);
  });
});

describe("synthesizeInitialTopic", () => {
  const record: TerminalRecord = [
    { kind: "herta", surface: "speech", text: "开场白" },
    { kind: "user", text: "第一条消息", at: "2026-07-12T00:00:00.000Z" },
  ];

  it("backfills a pre-topic-history session from its existing title", () => {
    expect(synthesizeInitialTopic("旧标题", [], record)).toEqual({
      title: "旧标题",
      anchorIndex: 1,
      anchorText: "第一条消息",
      at: "2026-07-12T00:00:00.000Z",
    });
  });

  it("returns null without a title, without a user block, or with history", () => {
    expect(synthesizeInitialTopic(null, [], record)).toBeNull();
    expect(synthesizeInitialTopic("t", [topic("t", 0)], record)).toBeNull();
    expect(
      synthesizeInitialTopic(
        "t",
        [],
        [{ kind: "herta", surface: "speech", text: "x" }],
      ),
    ).toBeNull();
  });
});
