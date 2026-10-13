import {
  type ActorPromptFrame,
  type ProviderAdapter,
  stripDisplayUnsafe,
} from "@herta/core";
import { escapeUserText } from "./escape.js";
import type { PromptLang } from "./prompt-lang.js";

/** Post-sanitize length cap in code points. 14 CJK chars carry roughly the
 *  same information as ~32 Latin chars, so the EN cap is wider — an English
 *  title cut at 14 characters would be unusable. zh behavior unchanged. */
const MAX_LEN: Record<PromptLang, number> = { zh: 14, en: 32 };

/** CN/EN co-located title-generator text (EN interaction slice 3b). */
const TITLE_TEXT = {
  zh: {
    system: [
      "你是一个会话标题生成器。",
      "请根据下面这段对话，生成一个简短、中立的中文标题，概括【开拓者】这一方想聊的主题或想做的事。",
      "",
      "硬性要求：",
      "- 标题里绝对不要出现任何人物名字或称呼（例如“黑塔”“开拓者”“螺丝”），也不要出现“我”“你”这类指代词。",
      "- 站在开拓者的角度，概括他想聊什么、想解决什么，而不是去描述黑塔的反应或回答。",
      "- 用中文；不超过 14 个字；只概括主题，不要复述原话。",
      "- 不要加引号、书名号或句末标点。",
      "- 只输出标题本身，不要任何解释或前后缀。",
      "",
      "示例：",
      "对话：开拓者让对方帮忙看 parser.ts 的报错。",
      "标题：排查解析报错",
      "对话：开拓者过来打招呼，只想随便聊聊。",
      "标题：日常闲聊",
    ].join("\n"),
    userLabel: "【开拓者】",
    hertaLabel: "【黑塔】",
    /** Incumbent-title contract (owner 2026-08-11): shown the current title,
     *  the model can express "still the same topic" as an exact copy — which
     *  the caller's exact-match dedup then swallows. Without this, a
     *  same-topic re-entry regenerated from scratch and a PARAPHRASE of the
     *  old title counted as a topic change: title churn plus a ghost tick on
     *  the topic rail. */
    incumbent: (title: string) =>
      [
        `当前标题：${title}`,
        "如果下面的对话仍然在聊当前标题概括的主题，请一字不改地原样输出当前标题；只有当话题确实变了，才生成新标题。",
      ].join("\n"),
  },
  en: {
    system: [
      "You are a session-title generator.",
      "From the conversation below, produce a short, neutral English title summarizing what the [Trailblazer] side wants to discuss or get done.",
      "",
      "Hard requirements:",
      '- Never include any character name or form of address in the title (e.g. "Herta", "Trailblazer", "Screwllum"), and no pronouns like "I" or "you".',
      "- Take the Trailblazer's perspective: summarize what they want to discuss or solve, not Herta's reaction or answer.",
      "- Use English; at most 5 words and 32 characters; capture only the topic — do not quote the original lines.",
      "- No quotation marks, brackets, or trailing punctuation.",
      "- Output only the title itself, with no explanation, prefix, or suffix.",
      "",
      "Examples:",
      "Conversation: the Trailblazer asks for help with an error reported in parser.ts.",
      "Title: Debugging a parser error",
      "Conversation: the Trailblazer drops by to say hello and just wants to chat.",
      "Title: Casual chat",
    ].join("\n"),
    userLabel: "[Trailblazer] ",
    hertaLabel: "[Herta] ",
    incumbent: (title: string) =>
      [
        `Current title: ${title}`,
        "If the conversation below is still about the topic the current title describes, output the current title EXACTLY as given, character for character. Only produce a new title when the topic has genuinely changed.",
      ].join("\n"),
  },
} as const;

const WRAP_OPEN = new Set([
  '"',
  "'",
  "“",
  "”",
  "「",
  "『",
  "《",
  "【",
  "(",
  "[",
]);
const WRAP_CLOSE = new Set([
  '"',
  "'",
  "“",
  "”",
  "」",
  "』",
  "》",
  "】",
  ")",
  "]",
]);
const TRAIL_PUNCT = new Set([
  "。",
  ".",
  "!",
  "！",
  "?",
  "？",
  "、",
  ",",
  "，",
  ";",
  "；",
  ":",
  "：",
  "…",
]);

/**
 * Build the flash-model chat frame for title generation. The model id is bound
 * to the provider (see `buildSupervisorPrompt`), not the frame — this frame is
 * provider-agnostic and only carries the system instruction + the user/Herta
 * exchange to summarize.
 */
export function buildTitlePrompt(input: {
  userText: string;
  hertaText: string;
  /** Language of the instruction prose and generated title. Default "zh". */
  readonly lang?: PromptLang;
  /** The session's current title, when it has one. Appends the incumbent
   *  contract to the system prompt — "copy it exactly if still on topic" —
   *  so same-topic retitles converge to a fixed point instead of churning
   *  through paraphrases. Absent (initial title): prompt byte-identical to
   *  before the contract existed. */
  readonly currentTitle?: string;
}): ActorPromptFrame {
  const text = TITLE_TEXT[input.lang ?? "zh"];
  // escapeUserText on BOTH sides (audit 2026-07-13 T2.5): this was the one
  // prompt sink interpolating raw text. Low stakes (isolated flash model,
  // sanitizeTitle + 14-char cap, output never re-enters the actor prompt),
  // but a forged block marker in either text has no business reaching ANY
  // model as structure. Idempotent over already-sanitized Herta speech.
  // The incumbent title passed through sanitizeTitle when it was made
  // (display-unsafe stripped, ≤ MAX_LEN), and escapeUserText again here —
  // same hygiene, same reasoning.
  const user = `${text.userLabel}${escapeUserText(input.userText)}\n${text.hertaLabel}${escapeUserText(input.hertaText)}`;
  const system =
    input.currentTitle === undefined
      ? text.system
      : `${text.system}\n\n${text.incumbent(escapeUserText(input.currentTitle))}`;
  return {
    stableSystem: system,
    memoryContext: "",
    retrievedLore: "",
    messages: [{ role: "user", text: user, ts: "1970-01-01T00:00:00.000Z" }],
    toolSchemas: [],
  };
}

/**
 * Normalize a raw model title: collapse whitespace, strip wrapping
 * quotes/brackets and trailing punctuation, cap length (with an ellipsis).
 * Returns `null` when nothing usable remains.
 */
export function sanitizeTitle(
  raw: string,
  lang: PromptLang = "zh",
): string | null {
  // stripDisplayUnsafe first: a bidi override in model output would render
  // the sidebar/tray title visually reversed; zero-width chars would make
  // two identical-looking titles differ (slice 2 display hygiene).
  let t = stripDisplayUnsafe(raw)
    .replace(/[\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  while (t.length > 0 && WRAP_OPEN.has(t.charAt(0))) t = t.slice(1).trim();
  while (t.length > 0 && WRAP_CLOSE.has(t.charAt(t.length - 1)))
    t = t.slice(0, -1).trim();
  while (t.length > 0 && TRAIL_PUNCT.has(t.charAt(t.length - 1)))
    t = t.slice(0, -1);
  t = t.trim();
  if (t.length === 0) return null;
  // Code-point-aware cap: `.slice` counts UTF-16 units and would split a
  // surrogate pair (an astral emoji at the cut becomes a lone surrogate —
  // mojibake in the sidebar). Spread iterates code points.
  const points = [...t];
  const maxLen = MAX_LEN[lang];
  if (points.length > maxLen) t = `${points.slice(0, maxLen).join("")}…`;
  return t;
}

/**
 * One-shot session-title generation. Never throws — returns the sanitized
 * title, or `null` on error / empty output (caller treats null as "keep the
 * placeholder").
 */
export async function generateSessionTitle(
  provider: ProviderAdapter,
  input: {
    userText: string;
    hertaText: string;
    readonly lang?: PromptLang;
    readonly currentTitle?: string;
  },
  signal: AbortSignal,
): Promise<string | null> {
  const frame = buildTitlePrompt(input);
  let buffered = "";
  try {
    for await (const ev of provider.streamChat(frame, signal)) {
      if (ev.type === "text-delta") buffered += ev.text;
      else if (ev.type === "finish") break;
    }
  } catch (err) {
    // Never throws — but says why (2026-09-03): the caller can only report
    // "returned nothing", and a 401/402/429 from the title model is the
    // difference between a key problem and a prompt problem.
    const e = err as { name?: unknown; status?: unknown; message?: unknown };
    console.warn(
      "[herta] title model call failed:",
      typeof e?.status === "number" ? `HTTP ${e.status}` : String(e?.name),
      String(e?.message ?? err),
    );
    return null;
  }
  // An exact copy of the incumbent skips sanitizeTitle: the incumbent already
  // passed it once, and running it AGAIN is not a no-op — a title that ended
  // with the cap's `…` would lose it to the trailing-punctuation strip, so
  // "copied exactly" would come back as a DIFFERENT string, defeating the
  // dedup the copy exists to hit.
  if (input.currentTitle !== undefined) {
    const copied = stripDisplayUnsafe(buffered).replace(/\s+/g, " ").trim();
    if (copied === input.currentTitle) return input.currentTitle;
  }
  const sanitized = sanitizeTitle(buffered, input.lang ?? "zh");
  // Same trap one step later: a faithful copy of a `…`-capped incumbent that
  // survives to sanitize comes back one ellipsis short. Restore the intent.
  if (
    sanitized !== null &&
    input.currentTitle !== undefined &&
    `${sanitized}…` === input.currentTitle
  ) {
    return input.currentTitle;
  }
  return sanitized;
}
