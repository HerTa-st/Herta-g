import { createHash } from "node:crypto";
import {
  errorMessage,
  journalUnavailableResult,
  type ToolContext,
  type ToolResult,
} from "@herta/core";

/**
 * Record a file write in the run's journal BEFORE it happens (ADR 0071
 * §1.1): the file's hash now and the hash it will have. A run the app died
 * in is sealed by comparing the file against both, so the write's outcome is
 * decided rather than guessed. Every writer calls this right before
 * `writeFileAtomic` (`journal-write.test.ts` holds that).
 *
 * Returns null when the write may go ahead (recorded, or the run keeps no
 * journal); otherwise the refusal to answer INSTEAD of writing — a write the
 * journal cannot record is not performed.
 */
export async function journalWrite<T>(
  ctx: ToolContext,
  path: string,
  before: string | null,
  afterBytes: Buffer | string,
): Promise<ToolResult<T> | null> {
  if (ctx.journal === undefined) return null;
  const after = createHash("sha256").update(afterBytes).digest("hex");
  try {
    await ctx.journal.recordWrite({ path, before, after });
    return null;
  } catch (err) {
    return journalUnavailableResult(errorMessage(err)) as ToolResult<T>;
  }
}
