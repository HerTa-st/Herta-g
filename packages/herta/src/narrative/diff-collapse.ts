import { COMPACTION_TEXT } from "./compaction-text.js";
import type { PromptLang } from "./prompt-lang.js";

/**
 * Diff-fence collapsing for system block bodies. Used in two places:
 *
 *   1. **CLI renderer** (`@herta/cli` `narrative-renderer.ts`): collapse
 *      long diffs in the on-screen `→ 系统` block so the terminal isn't
 *      flooded with hundred-line patches. Operator-tunable via
 *      `HERTA_DIFF_PREVIEW_MAX_LINES` (the CLI calls
 *      `resolveDiffPreviewMaxLines()` to read that env var).
 *
 *   2. **LLM prompt serializer** (`serialize.ts`): collapse long diffs
 *      in the serialized record passed to the LLM so multi-hundred-line
 *      patches don't eat the model's context window. Operator-tunable
 *      via `HERTA_DIFF_PROMPT_MAX_LINES`. The full diff stays in
 *      `TerminalRecord` and in the JSONL transcript on disk — only the
 *      LLM's view is compressed. (N6, 2026-05-23.)
 *
 * Both call-sites resolve their own max-lines so the CLI's render
 * truncation and the LLM's prompt truncation can be tuned independently.
 *
 * Function shape: collapse `\`\`\`diff … \`\`\`` fenced blocks inside
 * `body` to at most `maxLines` diff lines, appending a one-line
 * `… (N more lines suppressed — full diff in evidence)` footer. Fence
 * opens/closes themselves are preserved (we collapse the CONTENT, not
 * the wrapper) so downstream syntax-aware viewers still see a valid
 * fenced block.
 *
 * Returns the body unchanged when `maxLines === Infinity` (operator
 * opt-out).
 *
 * `lang` picks the footer's prose (`compaction-text.ts`) — it is the
 * only localized part, and both call-sites above have a session
 * language to hand. It defaults to `en` rather than the repo-wide `zh`
 * purely for back-compat: this is a pure exported function whose
 * historical footer was English, and the default keeps a caller that
 * knows no language producing exactly the bytes it always did.
 *
 * `audience` picks whose footer it is: the screen's names the evidence
 * the user can open; Herta's prompt says only that the rest wasn't
 * pasted, in her own words (ADR 0079 §2).
 */
export function collapseLongDiffs(
  body: string,
  maxLines: number,
  lang: PromptLang = "en",
  audience: "screen" | "herta" = "screen",
): string {
  if (!Number.isFinite(maxLines)) return body;
  const lines = body.split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line === "```diff") {
      // Find the matching closing fence. If the body is malformed
      // (no closing fence), treat the rest as diff content — better
      // than swallowing or de-fencing.
      let j = i + 1;
      while (j < lines.length && lines[j] !== "```") j += 1;
      const diffLines = lines.slice(i + 1, j);
      out.push(line);
      if (diffLines.length <= maxLines) {
        // Short enough — emit as-is.
        for (const dl of diffLines) out.push(dl);
      } else {
        // Truncate. Reserve one slot for the suppression footer so the
        // visible total = maxLines exactly (predictable for tests).
        const visibleCount = Math.max(1, maxLines - 1);
        const kept = diffLines.slice(0, visibleCount);
        const suppressed = diffLines.length - kept.length;
        for (const dl of kept) out.push(dl);
        const text = COMPACTION_TEXT[lang];
        out.push(
          audience === "herta"
            ? text.diffNotShown(suppressed)
            : text.diffSuppressed(suppressed),
        );
      }
      if (j < lines.length) out.push("```"); // closing fence
      i = j + 1;
    } else {
      if (line !== undefined) out.push(line);
      i += 1;
    }
  }
  return out.join("\n");
}

/**
 * Default maximum diff lines retained in the serialized prompt.
 * 20 matches the CLI's default — diffs up to ~20 lines pass through
 * unchanged, longer ones collapse to the first ~19 lines + a
 * suppression footer. Tunable via `HERTA_DIFF_PROMPT_MAX_LINES`
 * (separate from the CLI's `HERTA_DIFF_PREVIEW_MAX_LINES` so an
 * operator can see full diffs on screen while still keeping the
 * LLM's prompt compact).
 */
const DEFAULT_DIFF_PROMPT_MAX_LINES = 20;

/**
 * Read the LLM-prompt diff-collapse cap from the environment. Same
 * semantics as the CLI's `resolveDiffPreviewMaxLines` but reads a
 * different env var. `0` or `"unlimited"` disables collapse;
 * invalid values fall back to the default.
 */
export function resolveDiffPromptMaxLines(): number {
  const raw = process.env.HERTA_DIFF_PROMPT_MAX_LINES;
  if (raw === undefined || raw === "") return DEFAULT_DIFF_PROMPT_MAX_LINES;
  if (raw === "unlimited" || raw === "0") return Number.POSITIVE_INFINITY;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed < 1) {
    return DEFAULT_DIFF_PROMPT_MAX_LINES;
  }
  return parsed;
}
