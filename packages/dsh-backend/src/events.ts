/**
 * The wire shapes this package reads off a DeepSeek Harness (DSH) session.
 *
 * Captured from a real `sdk-minimal` profile run, not from the published
 * READMEs — the SDK's documented JS surface and its actual one disagree, so
 * the shapes here are the ones a live harness actually emits. Every field is
 * optional: this is a projection layer over an out-of-process product whose
 * event schema can grow, and a missing field must degrade the report rather
 * than throw. Only `turn/end` is load-bearing for correctness.
 */

export type DshContentBlock =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "reasoning"; readonly text: string }
  | {
      readonly type: "tool-call";
      readonly id: string;
      readonly name: string;
      /** JSON-encoded argument object, as a string, per the wire format. */
      readonly arguments: string;
    }
  | {
      readonly type: "tool-result";
      readonly toolCallId: string;
      readonly content: readonly DshContentBlock[];
      readonly isError?: boolean;
    };

/**
 * Every interface below carries an index signature for the same reason every
 * field is optional: DSH is a separately-versioned product whose event payloads
 * grow, and a fixture or a newer harness must never fail to typecheck — or
 * throw at runtime — just because it sent a field this package does not use.
 */
export interface DshMessage {
  readonly role?: string;
  readonly content?: readonly DshContentBlock[];
  readonly source?: {
    readonly kind?: string;
    readonly callId?: string;
    readonly plugin?: string;
    readonly provider?: string;
    readonly model?: string;
    readonly [key: string]: unknown;
  };
  readonly id?: string;
  readonly [key: string]: unknown;
}

export interface DshUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
  readonly cacheReadTokens?: number;
  readonly reasoningTokens?: number;
  readonly [key: string]: unknown;
}

export interface DshToolDeclaration {
  readonly name: string;
  readonly description?: string;
  readonly [key: string]: unknown;
}

export interface DshTurnReason {
  readonly kind: string;
  readonly error?: { readonly message?: string; readonly code?: string };
  readonly [key: string]: unknown;
}

export interface DshSessionEvent {
  readonly type: string;
  readonly seq?: number;
  readonly time?: number;
  readonly surfaceOp?: string;
  readonly sourceEventSeqs?: readonly number[];
  readonly data?: {
    readonly turn?: number;
    readonly step?: number;
    /**
     * `turn/end` carries `{kind, error?}`; `step/end` and `request/header`
     * carry a bare string ("initial", "completed"). Widened rather than
     * specialised per event type because one loose interface beats a
     * discriminated union that a newer harness can invalidate.
     */
    readonly reason?: DshTurnReason | string;
    /** `assistant/message`, `system/message`, `user/message`, `tool/result`. */
    readonly message?: DshMessage;
    readonly usage?: DshUsage;
    /** `tool/call`. */
    readonly callId?: string;
    readonly name?: string;
    readonly arguments?: string;
    /** `request/header`. */
    readonly header?: {
      readonly config?: {
        readonly provider?: string;
        readonly model?: string;
        readonly maxTokens?: number;
        readonly [key: string]: unknown;
      };
      readonly tools?: readonly DshToolDeclaration[];
      readonly [key: string]: unknown;
    };
    /** `session/title`. */
    readonly title?: string;
    readonly [key: string]: unknown;
  };
}

/** One `session/prompt` settlement, as the SDK client reports it. */
export interface DshRunResult {
  readonly sessionId?: string;
  readonly finalResponse?: string;
  readonly events?: readonly DshSessionEvent[];
}

/** JSON-RPC notification envelope the SDK hands to `onNotification`. */
export interface DshNotification {
  readonly method?: string;
  readonly params?: {
    readonly sessionId?: string;
    readonly event?: DshSessionEvent;
    readonly [key: string]: unknown;
  };
}
