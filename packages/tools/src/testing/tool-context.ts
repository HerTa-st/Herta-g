import {
  type AgentEvent,
  BackgroundHost,
  InMemoryEventBus,
  type MemoryManager,
  NoopMemoryManager,
  ReadLedger,
  type ToolContext,
} from "@herta/core";

export interface MkToolContextOptions {
  workspaceRoot: string;
  sessionId?: string;
  reads?: ReadLedger;
  bg?: BackgroundHost;
  bus?: InMemoryEventBus<AgentEvent>;
  signal?: AbortSignal;
  memory?: MemoryManager;
}

export function mkToolContext(opts: MkToolContextOptions): ToolContext {
  return {
    sessionId: opts.sessionId ?? "test-session",
    signal: opts.signal ?? new AbortController().signal,
    workspaceRoot: opts.workspaceRoot,
    reads: opts.reads ?? new ReadLedger(),
    bg: opts.bg ?? new BackgroundHost(),
    bus: opts.bus ?? new InMemoryEventBus<AgentEvent>(),
    memory: opts.memory ?? new NoopMemoryManager(),
  };
}
