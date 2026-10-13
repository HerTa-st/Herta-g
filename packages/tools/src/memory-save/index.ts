import { randomUUID } from "node:crypto";
import type {
  HertaTool,
  MemoryItem,
  MemoryKind,
  ToolCallRequest,
  ToolContext,
  ToolResult,
  ToolSchema,
} from "@herta/core";
import { formatInputIssues } from "../input-issues.js";
import { redactSecrets } from "../run-command/redactor.js";
import { memorySaveInputSchema, memorySaveJsonSchema } from "./schema.js";

export type { MemorySaveInput } from "./schema.js";

export interface MemorySaveData {
  id: string;
  kind: MemoryKind;
  text: string;
  why: string;
}

/**
 * What is worth a later run's attention (ADR 0077), from where Claude Code,
 * Codex and ZCode converge: only what the workspace cannot tell a later run
 * by itself, with the reason it holds. The same list rides the schema's
 * descriptions; a contract line is added only if a lab shows it is needed
 * (the minimal contract's own rule: prompt text earns its place by measured
 * behaviour).
 */
export const MEMORY_SAVE_DESCRIPTION =
  "Save a fact about this project for later runs in this workspace: each later dispatch starts with the saved facts, their age and their reason. Save only what the workspace cannot tell a later run by itself — a preference or correction the user stated (how to run the tests, a style rule, what not to touch), a quirk found the hard way (a flaky test, a broken script and its workaround), a mistake not to repeat. Do NOT save what a later run can read from the code, the config or git (layout, what a function does, history), a recipe for the change you just made, progress on the current task, command output, or secrets. Saving the same fact again re-confirms it.";

export function memorySaveTool(): HertaTool {
  return {
    name: "memory_save",
    schema(): ToolSchema {
      return {
        name: "memory_save",
        description: MEMORY_SAVE_DESCRIPTION,
        inputSchema: memorySaveJsonSchema,
      };
    },
    async run(
      call: ToolCallRequest,
      ctx: ToolContext,
    ): Promise<ToolResult<MemorySaveData>> {
      const parsed = memorySaveInputSchema.safeParse(call.input);
      if (!parsed.success) {
        return {
          ok: false,
          error: {
            code: "invalid_input",
            message: formatInputIssues(parsed.error),
            retryable: false,
          },
          suggestion: "usage: {kind, text, why}",
          summary: "invalid input",
        };
      }
      const input = parsed.data;
      const redactedText = redactSecrets(input.text);
      const redactedWhy = redactSecrets(input.why);
      const now = new Date().toISOString();
      const item: MemoryItem = {
        id: randomUUID(),
        scope: "repo",
        kind: input.kind,
        text: redactedText,
        why: redactedWhy,
        sourceSession: ctx.sessionId,
        createdAt: now,
        lastSeen: now,
        confidence: 1.0,
      };
      await ctx.memory.save(item);
      return {
        ok: true,
        data: {
          id: item.id,
          kind: item.kind,
          text: redactedText,
          why: redactedWhy,
        },
        summary: `remembered: ${input.kind}`,
      };
    },
  };
}
