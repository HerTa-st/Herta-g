import { describe, expect, it, vi } from "vitest";
import { ProviderError } from "../errors.js";
import { deepseekProvider } from "./factory.js";

const frame = {
  stableSystem: "s",
  memoryContext: "",
  retrievedLore: "",
  messages: [{ role: "user" as const, text: "hi", ts: "2026-09-03T00:00:00Z" }],
  toolSchemas: [],
};

async function drain(
  provider: ReturnType<typeof deepseekProvider>,
): Promise<void> {
  for await (const _ev of provider.streamChat(
    frame,
    new AbortController().signal,
  )) {
    // consume
  }
}

describe("deepseekProvider maxRetries passthrough (2026-09-03)", () => {
  it("maxRetries: 0 makes one POST and surfaces the 429 — the backend's setting, so the turn loop's policy paces alone", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("rate limited", { status: 429 }),
    );
    const provider = deepseekProvider({
      apiKey: "k",
      maxRetries: 0,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const err = await drain(provider).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).status).toBe(429);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("without the option the transport keeps its own retries (the actor and the sidecars)", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("rate limited", { status: 429 }),
    );
    const provider = deepseekProvider({
      apiKey: "k",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await drain(provider).catch(() => undefined);
    expect(fetchImpl.mock.calls.length).toBeGreaterThan(1);
  });
});
