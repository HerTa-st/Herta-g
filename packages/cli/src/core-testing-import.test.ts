import { FakeProvider } from "@herta/core/testing";
import { describe, expect, it } from "vitest";

describe("@herta/core/testing sub-export", () => {
  it("is importable from @herta/cli and constructs a FakeProvider", async () => {
    const provider = new FakeProvider({
      turns: [[{ type: "finish", reason: "stop" }]],
    });
    const ac = new AbortController();
    const events: unknown[] = [];
    for await (const e of provider.streamChat(
      {
        stableSystem: "",
        memoryContext: "",
        retrievedLore: "",
        messages: [],
        toolSchemas: [],
      },
      ac.signal,
    )) {
      events.push(e);
    }
    expect(events).toEqual([{ type: "finish", reason: "stop" }]);
  });
});
