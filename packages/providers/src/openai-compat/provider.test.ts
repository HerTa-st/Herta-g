import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PromptFrame, ProviderEvent } from "@herta/core";
import { describe, expect, it } from "vitest";
import { OpenAICompatibleProvider } from "./provider.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(HERE, "__fixtures__");

async function fakeFetchFromFixture(name: string): Promise<typeof fetch> {
  const text = await readFile(join(FIXTURE_DIR, name), "utf8");
  return async () =>
    new Response(text, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
}

const userOnly: PromptFrame = {
  stableSystem: "",
  repoInstructions: "",
  memoryContext: "",
  retrievedLore: "",
  messages: [{ role: "user", text: "hi", ts: "t" }],
  toolSchemas: [],
};

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const v of it) out.push(v);
  return out;
}

describe("OpenAICompatibleProvider", () => {
  it("happy text path produces deltas + finish", async () => {
    const provider = new OpenAICompatibleProvider({
      baseUrl: "https://example.test",
      apiKey: "sk",
      model: "deepseek-v4-pro",
      fetchImpl: await fakeFetchFromFixture("text-only.sse"),
    });
    const ctl = new AbortController();
    const events = (await collect(
      provider.streamChat(userOnly, ctl.signal),
    )) as ProviderEvent[];
    expect(events).toEqual([
      { type: "text-delta", text: "Hello" },
      { type: "text-delta", text: " world" },
      { type: "finish", reason: "stop" },
    ]);
  });

  it("tool-call fixture surfaces tool-call-request with parsed input", async () => {
    const provider = new OpenAICompatibleProvider({
      baseUrl: "https://example.test",
      apiKey: "sk",
      model: "deepseek-v4-pro",
      fetchImpl: await fakeFetchFromFixture("tool-call-single.sse"),
    });
    const events = (await collect(
      provider.streamChat(userOnly, new AbortController().signal),
    )) as ProviderEvent[];
    expect(events.find((e) => e.type === "tool-call-request")).toEqual({
      type: "tool-call-request",
      call: { id: "call_1", tool: "read_file", input: { path: "foo.ts" } },
    });
  });

  it("HTTP 401 throws ProviderError, no events yielded", async () => {
    const provider = new OpenAICompatibleProvider({
      baseUrl: "https://example.test",
      apiKey: "sk",
      model: "deepseek-v4-pro",
      fetchImpl: async () =>
        new Response('{"error":{"message":"bad key"}}', {
          status: 401,
          headers: { "content-type": "application/json" },
        }),
    });
    await expect(
      collect(provider.streamChat(userOnly, new AbortController().signal)),
    ).rejects.toMatchObject({
      name: "ProviderError",
      code: "http",
      status: 401,
      retryable: false,
    });
  });

  it("preflight abort throws before fetch", async () => {
    let fetched = false;
    const provider = new OpenAICompatibleProvider({
      baseUrl: "https://example.test",
      apiKey: "sk",
      model: "deepseek-v4-pro",
      fetchImpl: async () => {
        fetched = true;
        return new Response("", { status: 200 });
      },
    });
    const ctl = new AbortController();
    ctl.abort();
    await expect(
      collect(provider.streamChat(userOnly, ctl.signal)),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(fetched).toBe(false);
  });

  it("aborts mid-stream within 200ms", async () => {
    const provider = new OpenAICompatibleProvider({
      baseUrl: "https://example.test",
      apiKey: "sk",
      model: "deepseek-v4-pro",
      fetchImpl: async (_url, init) => {
        const signal = init?.signal as AbortSignal;
        const stream = new ReadableStream<Uint8Array>({
          async pull(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                `data: {"choices":[{"index":0,"delta":{"content":"H"}}]}\n\n`,
              ),
            );
            await new Promise<void>((resolve, reject) => {
              const t = setTimeout(resolve, 5000);
              signal.addEventListener(
                "abort",
                () => {
                  clearTimeout(t);
                  reject(new DOMException("aborted", "AbortError"));
                },
                { once: true },
              );
            });
            controller.close();
          },
        });
        return new Response(stream, { status: 200 });
      },
    });
    const ctl = new AbortController();
    const start = Date.now();
    setTimeout(() => ctl.abort(), 10);
    await expect(
      collect(provider.streamChat(userOnly, ctl.signal)),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(Date.now() - start).toBeLessThan(200);
  });
});
