import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  readSessionTitle,
  readSessionTopics,
  type SessionTopic,
  writeSessionTitle,
} from "./session-title-sidecar.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "herta-title-"));
}

describe("session title sidecar", () => {
  it("round-trips a title", () => {
    const dir = tmp();
    writeSessionTitle(dir, "abc", "排查失踪引用");
    expect(readSessionTitle(dir, "abc")).toBe("排查失踪引用");
  });

  it("returns undefined when absent", () => {
    expect(readSessionTitle(tmp(), "nope")).toBeUndefined();
  });

  it("returns undefined on corrupt JSON", () => {
    const dir = tmp();
    writeFileSync(join(dir, "bad.title.json"), "{not json", "utf8");
    expect(readSessionTitle(dir, "bad")).toBeUndefined();
  });

  it("round-trips the topic history alongside the title", () => {
    const dir = tmp();
    const topics: SessionTopic[] = [
      { title: "排查失踪引用", anchorIndex: 0, anchorText: "查一下", at: "t1" },
      { title: "补充测试", anchorIndex: 8, anchorText: "加个测试", at: "t2" },
    ];
    writeSessionTitle(dir, "abc", "补充测试", topics);
    expect(readSessionTitle(dir, "abc")).toBe("补充测试");
    expect(readSessionTopics(dir, "abc")).toEqual(topics);
  });

  it("a pre-topic sidecar (no topics field) reads as an empty history", () => {
    const dir = tmp();
    writeSessionTitle(dir, "old", "旧标题"); // no topics arg
    expect(readSessionTopics(dir, "old")).toEqual([]);
    expect(readSessionTopics(tmp(), "absent")).toEqual([]);
  });

  it("drops malformed topic ENTRIES, keeping the valid ones", () => {
    const dir = tmp();
    writeFileSync(
      join(dir, "mix.title.json"),
      `${JSON.stringify({
        version: 1,
        title: "t",
        generatedAt: "x",
        topics: [
          { title: "ok", anchorIndex: 2, anchorText: "a", at: "t" },
          { title: "no-anchor", anchorText: "a", at: "t" },
          { title: "neg", anchorIndex: -1, anchorText: "a", at: "t" },
          "garbage",
        ],
      })}\n`,
      "utf8",
    );
    expect(readSessionTopics(dir, "mix")).toEqual([
      { title: "ok", anchorIndex: 2, anchorText: "a", at: "t" },
    ]);
  });
});
