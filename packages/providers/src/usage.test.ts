import type { CompletionEvent, ProviderEvent } from "@herta/core";
import { afterEach, describe, expect, it } from "vitest";
import { OpenAICompatibleCompletionProvider } from "./openai-compat/completion-provider.js";
import { mapCompletionStream } from "./openai-compat/completion-stream.js";
import { OpenAICompatibleProvider } from "./openai-compat/provider.js";
import { mapStream } from "./openai-compat/stream.js";
import {
  type ProviderUsage,
  parseUsageChunk,
  reportProviderUsage,
  setProviderUsageSink,
} from "./usage.js";

async function* fromArray(items: unknown[]): AsyncGenerator<unknown> {
  for (const i of items) yield i;
}
const live = new AbortController().signal;

// The shape DeepSeek really sends (probed live 2026-09-20): usage rides the
// chunk that carries finish_reason, on both endpoints.
const DEEPSEEK_USAGE = {
  prompt_tokens: 21_930,
  completion_tokens: 188,
  total_tokens: 22_118,
  prompt_tokens_details: { cached_tokens: 21_504 },
  prompt_cache_hit_tokens: 21_504,
  prompt_cache_miss_tokens: 426,
};

afterEach(() => setProviderUsageSink(undefined));

describe("parseUsageChunk", () => {
  it("reads DeepSeek's block, cache pair included", () => {
    expect(parseUsageChunk({ choices: [], usage: DEEPSEEK_USAGE })).toEqual({
      promptTokens: 21_930,
      completionTokens: 188,
      cacheHitTokens: 21_504,
      cacheMissTokens: 426,
    });
  });

  it("accepts OpenAI's cached_tokens as the hit count and derives the miss", () => {
    expect(
      parseUsageChunk({
        usage: {
          prompt_tokens: 100,
          completion_tokens: 5,
          prompt_tokens_details: { cached_tokens: 64 },
        },
      }),
    ).toEqual({
      promptTokens: 100,
      completionTokens: 5,
      cacheHitTokens: 64,
      cacheMissTokens: 36,
    });
  });

  it("says nothing about a cache the provider did not mention", () => {
    expect(
      parseUsageChunk({ usage: { prompt_tokens: 10, completion_tokens: 2 } }),
    ).toEqual({
      promptTokens: 10,
      completionTokens: 2,
      cacheHitTokens: null,
      cacheMissTokens: null,
    });
  });

  it("is null for the placeholder, an absent block and junk", () => {
    expect(parseUsageChunk({ choices: [{}], usage: null })).toBeNull();
    expect(parseUsageChunk({ choices: [{}] })).toBeNull();
    expect(parseUsageChunk(null)).toBeNull();
    expect(parseUsageChunk("usage")).toBeNull();
    expect(parseUsageChunk({ usage: { prompt_tokens: "7" } })).toBeNull();
    expect(
      parseUsageChunk({ usage: { prompt_tokens: -1, completion_tokens: 1 } }),
    ).toBeNull();
  });
});

describe("the stream mappers state usage BEFORE finish — every consumer stops reading there", () => {
  it("chat: a consumer that breaks at finish has already been told", async () => {
    const seen: unknown[] = [];
    const order: string[] = [];
    const events = mapStream(
      fromArray([
        { choices: [{ delta: { content: "hi" } }], usage: null },
        {
          choices: [{ delta: {}, finish_reason: "stop" }],
          usage: DEEPSEEK_USAGE,
        },
      ]),
      live,
      (u) => {
        seen.push(u);
        order.push("usage");
      },
    );
    for await (const ev of events as AsyncIterable<ProviderEvent>) {
      order.push(ev.type);
      if (ev.type === "finish") break;
    }
    expect(order).toEqual(["text-delta", "usage", "finish"]);
    expect(seen).toEqual([
      {
        promptTokens: 21_930,
        completionTokens: 188,
        cacheHitTokens: 21_504,
        cacheMissTokens: 426,
      },
    ]);
  });

  it("completion: the same, and a stream without usage reports nothing", async () => {
    const order: string[] = [];
    for await (const ev of mapCompletionStream(
      fromArray([
        { choices: [{ text: "嗯" }] },
        {
          choices: [{ text: "", finish_reason: "stop" }],
          usage: DEEPSEEK_USAGE,
        },
      ]),
      live,
      () => order.push("usage"),
    ) as AsyncIterable<CompletionEvent>) {
      order.push(ev.type);
      if (ev.type === "finish") break;
    }
    expect(order).toEqual(["text-delta", "usage", "finish"]);

    let told = 0;
    for await (const _ of mapCompletionStream(
      fromArray([{ choices: [{ text: "x", finish_reason: "stop" }] }]),
      live,
      () => {
        told += 1;
      },
    )) {
      // drain
    }
    expect(told).toBe(0);
  });

  it("reads an OpenAI-style trailing usage chunk when the consumer drains that far", async () => {
    const seen: unknown[] = [];
    for await (const _ of mapStream(
      fromArray([
        { choices: [{ delta: { content: "a" }, finish_reason: "stop" }] },
        { choices: [], usage: { prompt_tokens: 3, completion_tokens: 1 } },
      ]),
      live,
      (u) => seen.push(u),
    )) {
      // drain
    }
    expect(seen).toHaveLength(1);
  });
});

describe("the providers name the endpoint and the model, and tell both listeners", () => {
  const sse = (chunks: unknown[]): typeof fetch => {
    const text = `${chunks
      .map((c) => `data: ${JSON.stringify(c)}\n\n`)
      .join("")}data: [DONE]\n\n`;
    return async () =>
      new Response(text, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
  };

  it("chat", async () => {
    const sink: ProviderUsage[] = [];
    const own: ProviderUsage[] = [];
    setProviderUsageSink((u) => sink.push(u));
    const provider = new OpenAICompatibleProvider({
      baseUrl: "https://example.test",
      apiKey: "sk",
      model: "deepseek-flash",
      onUsage: (u) => own.push(u),
      fetchImpl: sse([
        { choices: [{ delta: { content: "hi" } }] },
        {
          choices: [{ delta: {}, finish_reason: "stop" }],
          usage: DEEPSEEK_USAGE,
        },
      ]),
    });
    for await (const ev of provider.streamChat(
      {
        stableSystem: "",
        memoryContext: "",
        retrievedLore: "",
        messages: [{ role: "user", text: "hi", ts: "t" }],
        toolSchemas: [],
      },
      live,
    )) {
      if (ev.type === "finish") break; // as the real consumers do
    }
    const expected: ProviderUsage = {
      endpoint: "chat",
      model: "deepseek-flash",
      promptTokens: 21_930,
      completionTokens: 188,
      cacheHitTokens: 21_504,
      cacheMissTokens: 426,
    };
    expect(sink).toEqual([expected]);
    expect(own).toEqual([expected]);
  });

  it("completion — the model is the REQUEST's", async () => {
    const sink: ProviderUsage[] = [];
    setProviderUsageSink((u) => sink.push(u));
    const provider = new OpenAICompatibleCompletionProvider({
      baseUrl: "https://example.test",
      apiKey: "sk",
      path: "/beta/completions",
      fetchImpl: sse([
        { choices: [{ text: "嗯" }] },
        {
          choices: [{ text: "", finish_reason: "stop" }],
          usage: DEEPSEEK_USAGE,
        },
      ]),
    });
    for await (const ev of provider.streamCompletion(
      { model: "deepseek-v4-pro", prompt: "（我 说）", stop: ["\n"] },
      live,
    )) {
      if (ev.type === "finish") break;
    }
    expect(sink).toEqual([
      {
        endpoint: "completion",
        model: "deepseek-v4-pro",
        promptTokens: 21_930,
        completionTokens: 188,
        cacheHitTokens: 21_504,
        cacheMissTokens: 426,
      },
    ]);
  });
});

describe("the process-wide sink", () => {
  const usage: ProviderUsage = {
    endpoint: "chat",
    model: "deepseek-flash",
    promptTokens: 1,
    completionTokens: 1,
    cacheHitTokens: 0,
    cacheMissTokens: 1,
  };

  it("receives reports while installed and nothing after", () => {
    const got: ProviderUsage[] = [];
    reportProviderUsage(usage); // no sink: a no-op
    setProviderUsageSink((u) => got.push(u));
    reportProviderUsage(usage);
    setProviderUsageSink(undefined);
    reportProviderUsage(usage);
    expect(got).toEqual([usage]);
  });

  it("a sink that throws never reaches the call it observes", () => {
    setProviderUsageSink(() => {
      throw new Error("disk full");
    });
    expect(() => reportProviderUsage(usage)).not.toThrow();
  });
});
