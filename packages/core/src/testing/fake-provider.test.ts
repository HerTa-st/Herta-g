import { describe, expect, it } from "vitest";
import type { PromptFrame } from "../types/prompt.js";
import type { ProviderEvent } from "../types/provider.js";
import { FakeProvider } from "./fake-provider.js";

const FRAME: PromptFrame = {
  stableSystem: "",
  memoryContext: "",
  retrievedLore: "",
  messages: [],
  toolSchemas: [],
};

async function collect(
  stream: AsyncIterable<ProviderEvent>,
): Promise<ProviderEvent[]> {
  const out: ProviderEvent[] = [];
  for await (const e of stream) out.push(e);
  return out;
}

describe("FakeProvider", () => {
  it("yields events from the first scripted turn", async () => {
    const provider = new FakeProvider({
      turns: [
        [
          { type: "text-delta", text: "hello " },
          { type: "text-delta", text: "world" },
          { type: "finish", reason: "stop" },
        ],
      ],
    });
    const events = await collect(
      provider.streamChat(FRAME, new AbortController().signal),
    );
    expect(events).toHaveLength(3);
    expect(events[0]).toEqual({ type: "text-delta", text: "hello " });
  });

  it("advances to the next scripted turn on subsequent streamChat calls", async () => {
    const provider = new FakeProvider({
      turns: [
        [
          { type: "text-delta", text: "a" },
          { type: "finish", reason: "stop" },
        ],
        [
          { type: "text-delta", text: "b" },
          { type: "finish", reason: "stop" },
        ],
      ],
    });
    const t1 = await collect(
      provider.streamChat(FRAME, new AbortController().signal),
    );
    const t2 = await collect(
      provider.streamChat(FRAME, new AbortController().signal),
    );
    expect((t1[0] as { text: string }).text).toBe("a");
    expect((t2[0] as { text: string }).text).toBe("b");
  });

  it("supports function-form scripted turns that see the frame", async () => {
    const provider = new FakeProvider({
      turns: [
        (frame) => [
          { type: "text-delta", text: `${frame.messages.length} msgs` },
          { type: "finish", reason: "stop" },
        ],
      ],
    });
    const events = await collect(
      provider.streamChat(FRAME, new AbortController().signal),
    );
    expect((events[0] as { text: string }).text).toBe("0 msgs");
  });

  it("throws AbortError if the signal is aborted before iteration", async () => {
    const provider = new FakeProvider({
      turns: [[{ type: "finish", reason: "stop" }]],
    });
    const ac = new AbortController();
    ac.abort();
    await expect(
      collect(provider.streamChat(FRAME, ac.signal)),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("throws AbortError when aborted mid-stream", async () => {
    const provider = new FakeProvider({
      turns: [
        [
          { type: "text-delta", text: "a" },
          { type: "text-delta", text: "b" },
          { type: "finish", reason: "stop" },
        ],
      ],
    });
    const ac = new AbortController();
    const stream = provider.streamChat(FRAME, ac.signal);
    const seen: ProviderEvent[] = [];
    await expect(
      (async () => {
        for await (const e of stream) {
          seen.push(e);
          ac.abort();
        }
      })(),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(seen).toHaveLength(1);
  });

  it("throws if the script runs out of turns", async () => {
    const provider = new FakeProvider({ turns: [] });
    await expect(
      collect(provider.streamChat(FRAME, new AbortController().signal)),
    ).rejects.toThrowError(/script exhausted/i);
  });
});
