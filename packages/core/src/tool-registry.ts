import type {
  HertaTool,
  OutputFn,
  ProgressFn,
  ToolCallRequest,
  ToolContext,
  ToolResult,
} from "./types/tool.js";

export interface ToolRegistry {
  register(tool: HertaTool): void;
  get(name: string): HertaTool | undefined;
  list(): HertaTool[];
  run(
    call: ToolCallRequest,
    ctx: ToolContext,
    progress: ProgressFn,
    output?: OutputFn,
  ): Promise<ToolResult>;
}

export class InMemoryToolRegistry implements ToolRegistry {
  private tools = new Map<string, HertaTool>();

  register(tool: HertaTool): void {
    this.tools.set(tool.name, tool);
  }

  /** Remove a tool by name; a name not registered is a no-op. The toolset
   *  follows the environment per session (ADR 0067): the wiring unmounts the
   *  git tools when the workspace moves out of a repository. */
  unregister(name: string): void {
    this.tools.delete(name);
  }

  get(name: string): HertaTool | undefined {
    return this.tools.get(name);
  }

  list(): HertaTool[] {
    return [...this.tools.values()];
  }

  async run(
    call: ToolCallRequest,
    ctx: ToolContext,
    progress: ProgressFn,
    output?: OutputFn,
  ): Promise<ToolResult> {
    const tool = this.tools.get(call.tool);
    if (!tool) {
      return {
        ok: false,
        error: {
          code: "unknown_tool",
          message: `tool not registered: ${call.tool}`,
          retryable: false,
        },
        summary: `unknown tool: ${call.tool}`,
      };
    }
    return tool.run(call, ctx, progress, output);
  }
}
