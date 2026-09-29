import type { TerminalRecord } from "@herta/core";
import { describe, expect, it } from "vitest";
import { recallLastMessage } from "./recall-last-message.js";

const record: TerminalRecord = [
  { kind: "user", text: "先看看 parser" },
  { kind: "herta", surface: "speech", text: "好。" },
  { kind: "user", text: "@板砖 修掉它" },
  { kind: "herta", surface: "speech", text: "交给板砖了。" },
  { kind: "user", text: "顺便跑一下测试", steer: true },
  { kind: "user", text: "继续", resume: true },
];

describe("Up-arrow recall (ADR 0072 §3)", () => {
  it("is the last message the user sent — not a steer, not a 继续", () => {
    expect(recallLastMessage(record, "zh")).toBe("@板砖 修掉它");
  });

  it("gives an EN session its @Brick back", () => {
    expect(recallLastMessage(record, "en")).toBe("@Brick 修掉它");
  });

  it("is nothing when the session has no message yet", () => {
    expect(recallLastMessage([], "zh")).toBeNull();
    expect(
      recallLastMessage(
        [{ kind: "herta", surface: "speech", text: "你来了。" }],
        "zh",
      ),
    ).toBeNull();
  });
});
