import type { ActorPromptFrame, BackendPromptFrame } from "./prompt.js";
import type { ToolCallRequest } from "./tool.js";

export type ProviderEvent =
  | { type: "text-delta"; text: string }
  | { type: "reasoning-delta"; text: string }
  /** A fragment of a tool call's arguments as it streams (ADR 0073). Sent
   *  once the call's id and name are known; the finished call still arrives
   *  as `tool-call-request`. */
  | { type: "tool-call-delta"; id: string; tool: string; argsDelta: string }
  | { type: "tool-call-request"; call: ToolCallRequest }
  | { type: "finish"; reason: "stop" | "tool_calls" | "length" | "error" };

/**
 * A provider-bound prompt frame is either the actor frame (full Herta
 * identity context) or the backend frame (execution contract + brief, no
 * Herta identity). Translation logic dispatches on the discriminator.
 */
export type ProviderPromptFrame = ActorPromptFrame | BackendPromptFrame;

export interface ProviderAdapter {
  streamChat(
    frame: ProviderPromptFrame,
    signal: AbortSignal,
  ): AsyncIterable<ProviderEvent>;
}
