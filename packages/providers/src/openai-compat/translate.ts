import type {
  ActorPromptFrame,
  BackendPromptFrame,
  Message,
  ProviderPromptFrame,
  ToolSchema,
} from "@herta/core";
import { toolMessageContent } from "@herta/core";

export interface TranslateOpts {
  model: string;
  temperature?: number;
  maxTokens?: number;
  extraBody?: Record<string, unknown>;
}

interface OpenAIToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

/** OpenAI-style content parts. Only the user role takes them, and only for
 *  images (ADR 0048 slice 3) — everything else in this wire format is a
 *  plain string, and keeping it that way is what makes the prompt-cache
 *  bytes stable for the 99% of messages that carry no picture. */
type OpenAIContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

type OpenAIMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string | OpenAIContentPart[] }
  | {
      role: "assistant";
      content: string | null;
      tool_calls?: OpenAIToolCall[];
      reasoning_content?: string;
    }
  | { role: "tool"; tool_call_id: string; content: string };

interface OpenAITool {
  type: "function";
  function: { name: string; description: string; parameters: unknown };
}

export interface OpenAIChatRequest {
  model: string;
  stream: true;
  messages: OpenAIMessage[];
  tools?: OpenAITool[];
  temperature?: number;
  max_tokens?: number;
  [vendorKey: string]: unknown;
}

export function translate(
  frame: ProviderPromptFrame,
  opts: TranslateOpts,
): OpenAIChatRequest {
  if ("backendSystem" in frame) {
    return translateBackend(frame, opts);
  }
  return translateActor(frame, opts);
}

export function translateActor(
  frame: ActorPromptFrame,
  opts: TranslateOpts,
): OpenAIChatRequest {
  const messages: OpenAIMessage[] = [];
  if (frame.stableSystem.length > 0) {
    messages.push({ role: "system", content: frame.stableSystem });
  }
  if (frame.repoInstructions.length > 0) {
    messages.push({ role: "system", content: frame.repoInstructions });
  }
  if (frame.memoryContext.length > 0) {
    messages.push({ role: "system", content: frame.memoryContext });
  }
  if (frame.retrievedLore.length > 0) {
    messages.push({ role: "system", content: frame.retrievedLore });
  }
  for (const m of frame.messages) {
    messages.push(...toOpenAI(m));
  }
  const tools =
    frame.toolSchemas.length > 0 ? frame.toolSchemas.map(toTool) : undefined;
  return finalizeRequest(messages, tools, opts);
}

export function translateBackend(
  frame: BackendPromptFrame,
  opts: TranslateOpts,
): OpenAIChatRequest {
  const messages: OpenAIMessage[] = [];
  if (frame.backendSystem.length > 0) {
    messages.push({ role: "system", content: frame.backendSystem });
  }
  if (frame.scopedRepoInstructions.length > 0) {
    messages.push({ role: "system", content: frame.scopedRepoInstructions });
  }
  if (frame.scopedMemory.length > 0) {
    messages.push({ role: "system", content: frame.scopedMemory });
  }
  for (const m of frame.messages) {
    messages.push(...toOpenAI(m));
  }
  // The per-iteration state trailer (todo list, working state, steps left):
  // trails the transcript so the stable prefix keeps its prompt-cache bytes;
  // recomputed each call by the turn loop and never part of the durable
  // transcript.
  if (frame.trailingState !== undefined && frame.trailingState.length > 0) {
    messages.push({ role: "system", content: frame.trailingState });
  }
  const tools =
    frame.toolSchemas.length > 0 ? frame.toolSchemas.map(toTool) : undefined;
  return finalizeRequest(messages, tools, opts);
}

function finalizeRequest(
  messages: OpenAIMessage[],
  tools: OpenAITool[] | undefined,
  opts: TranslateOpts,
): OpenAIChatRequest {
  const base: OpenAIChatRequest = {
    model: opts.model,
    stream: true,
    messages,
  };
  if (tools !== undefined) base.tools = tools;
  if (opts.temperature !== undefined) base.temperature = opts.temperature;
  if (opts.maxTokens !== undefined) base.max_tokens = opts.maxTokens;
  if (opts.extraBody !== undefined) Object.assign(base, opts.extraBody);
  return base;
}

/**
 * One transcript message → the wire messages it becomes.
 *
 * Almost always exactly one. The exception is a tool result carrying images
 * (ADR 0048 slice 3): the API takes images in `user` messages only, so the
 * tool message goes out as text and a synthetic user message follows with
 * the picture parts. Returning an array keeps that fan-out here, in the
 * layer that knows the wire format, rather than leaking a provider rule into
 * the transcript.
 */
function toOpenAI(m: Message): OpenAIMessage[] {
  if (m.role === "user") {
    return [{ role: "user", content: m.text }];
  }
  if (m.role === "assistant") {
    if (m.toolCalls.length === 0) {
      const out: Extract<OpenAIMessage, { role: "assistant" }> = {
        role: "assistant",
        content: m.text,
      };
      if (m.reasoningContent !== undefined && m.reasoningContent.length > 0) {
        out.reasoning_content = m.reasoningContent;
      }
      return [out];
    }
    const out: Extract<OpenAIMessage, { role: "assistant" }> = {
      role: "assistant",
      content: m.text.length > 0 ? m.text : null,
      tool_calls: m.toolCalls.map((c) => ({
        id: c.id,
        type: "function",
        function: { name: c.tool, arguments: JSON.stringify(c.input ?? {}) },
      })),
    };
    if (m.reasoningContent !== undefined && m.reasoningContent.length > 0) {
      out.reasoning_content = m.reasoningContent;
    }
    return [out];
  }
  const toolMessage: OpenAIMessage = {
    role: "tool",
    tool_call_id: m.toolCallId,
    content: toolMessageContent(m.result),
  };
  const images = m.result.images ?? [];
  if (images.length === 0) return [toolMessage];
  return [
    toolMessage,
    {
      role: "user",
      // The text part names the files so the picture is anchored to a path
      // the model can cite; without it the images arrive unlabelled and a
      // multi-image call cannot say which is which.
      content: [
        {
          type: "text",
          text: `[${images.map((i) => i.path).join(", ")}]`,
        },
        ...images.map(
          (i): OpenAIContentPart => ({
            type: "image_url",
            image_url: { url: i.dataUri },
          }),
        ),
      ],
    },
  ];
}

function toTool(s: ToolSchema): OpenAITool {
  return {
    type: "function",
    function: {
      name: s.name,
      description: s.description,
      parameters: s.inputSchema,
    },
  };
}
