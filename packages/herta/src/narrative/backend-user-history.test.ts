import type { TerminalRecord } from "@herta/core";
import { describe, expect, it } from "vitest";
import { extractUserMessages } from "./backend-user-history.js";

describe("extractUserMessages — what 板砖 is told the user asked", () => {
  it("a 继续 block is the harness's own turn, not a task the user set (review 2026-09-30)", () => {
    const record = [
      { kind: "user", text: "修 parser" },
      { kind: "herta", surface: "speech", text: "好。" },
      { kind: "user", text: "继续", resume: true },
      { kind: "user", text: "再跑一遍测试" },
    ] as unknown as TerminalRecord;
    expect(extractUserMessages(record).messages.map((m) => m.text)).toEqual([
      "修 parser",
      "再跑一遍测试",
    ]);
  });
});
