import type { ToolCallRequest, ToolResult } from "./types/tool.js";
import type {
  AssistantMessage,
  Message,
  ToolMessage,
  UserMessage,
} from "./types/transcript.js";

export interface TranscriptStoreOpts {
  /**
   * Optional callback fired once per appended message. The store passes a
   * frozen reference to the message it just pushed. Use cases: persist to
   * disk, mirror to a debug log, emit a stream event. Exceptions thrown
   * from the callback propagate to the caller — keep the implementation
   * cheap and non-throwing for production use.
   */
  onAppend?: (msg: Message) => void;
}

export class TranscriptStore {
  private messages: Message[] = [];
  private readonly onAppend: ((msg: Message) => void) | undefined;

  constructor(opts: TranscriptStoreOpts = {}) {
    this.onAppend = opts.onAppend;
  }

  appendUser(text: string, ts: Date): UserMessage {
    const msg: UserMessage = { role: "user", text, ts: ts.toISOString() };
    this.messages.push(msg);
    this.onAppend?.(msg);
    return msg;
  }

  appendAssistant(
    text: string,
    toolCalls: ToolCallRequest[],
    ts: Date,
    reasoningContent?: string,
  ): AssistantMessage {
    const msg: AssistantMessage = {
      role: "assistant",
      text,
      toolCalls,
      ts: ts.toISOString(),
    };
    if (reasoningContent !== undefined && reasoningContent.length > 0) {
      msg.reasoningContent = reasoningContent;
    }
    this.messages.push(msg);
    this.onAppend?.(msg);
    return msg;
  }

  appendTool(toolCallId: string, result: ToolResult, ts: Date): ToolMessage {
    const msg: ToolMessage = {
      role: "tool",
      toolCallId,
      result,
      ts: ts.toISOString(),
    };
    this.messages.push(msg);
    this.onAppend?.(msg);
    return msg;
  }

  /**
   * Start from an earlier conversation (a continued run, ADR 0071 §1.5):
   * the messages are taken as they are, and `onAppend` is NOT called — they
   * are already recorded wherever it records to.
   */
  seed(messages: readonly Message[]): void {
    this.messages.push(...messages);
  }

  all(): readonly Message[] {
    return this.messages;
  }

  lastUserMessage(): UserMessage | undefined {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const m = this.messages[i];
      if (m?.role === "user") return m;
    }
    return undefined;
  }

  clear(): void {
    this.messages = [];
  }

  /** Removes the oldest N messages. No-op if N <= 0. */
  dropOldest(n: number): void {
    if (n <= 0) return;
    this.messages.splice(0, n);
  }
}
