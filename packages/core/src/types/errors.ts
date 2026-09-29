export type AgentErrorKind =
  | "interrupted"
  | "provider_failed"
  | "tool_failed"
  | "permission_denied"
  | "invalid_tool_call"
  /** The run reached its step limit (MAX_TURN_ITERATIONS): it ends where it
   *  stands, like an interruption, and can be continued (2026-09-29). */
  | "step_limit"
  | "internal";

export interface AgentError {
  kind: AgentErrorKind;
  message: string;
  cause?: unknown;
}
