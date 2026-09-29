import { aliasBanzhuanPlain } from "./banzhuan-mention.js";

/**
 * What "copy this reply" puts on the clipboard (ADR 0072 §3): Herta's PROSE
 * only. A fenced code block is left out (owner, 2026-09-29) — the code cards
 * deliberately carry no copy affordance, since pasted code rewarded is pasted
 * code repeated (HertaBubble.tsx, Slice 5 Q1). An unclosed fence drops the
 * rest. Paragraphs keep their blank line; 板砖 shows as Brick in an EN
 * session, as the bubble shows it. "" when nothing but code is left.
 */
export function replyProse(text: string, lang: "zh" | "en"): string {
  const prose = text
    .replace(/```[\s\S]*?(?:```|$)/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return prose.length === 0 ? "" : aliasBanzhuanPlain(prose, lang);
}
