import type {
  ActorPromptFrame,
  ProviderAdapter,
  ProviderEvent,
  TerminalRecord,
  TerminalRecordBlock,
} from "@herta/core";
import { MOOD_STATES, type MoodState } from "./meta-think.js";
import type { PromptLang } from "./prompt-lang.js";
import { serializeTerminalRecord } from "./serialize.js";

/**
 * Input to the intent router classifier. The recentRecord MUST be
 * pre-filtered to user + herta-speech blocks only (see
 * `lastNSpeechTurns`).
 *
 * `provider` is a chat-mode `ProviderAdapter` (typically
 * `deepseekProvider(..., thinking: "low")` since the 2026-07-31 flash
 * update — thinking MODE is what matters here, not depth). The previous
 * completion-mode
 * implementation could not classify reliably — non-thinking flash either
 * collided with `stop: ["\n"]` to produce empty output, or emitted JSON
 * schema-descriptive metalanguage (`所选状态`/`状态名`) instead of an
 * actual state value. Thinking-mode chat gives the model enough cognitive
 * headroom to follow the classifier instructions.
 *
 * The model name lives on the provider instance (`deepseekProvider`'s
 * `model` factory option); there is no per-call model field anymore.
 *
 * SPEC v0.2 Slice 13 §5.2, §6.
 */
export interface ClassifyIntentInput {
  readonly recentRecord: readonly TerminalRecordBlock[];
  readonly currentState: MoodState;
  readonly provider: ProviderAdapter;
  readonly signal: AbortSignal;
  /**
   * Language of the classifier's instructional prose (EN interaction
   * slice 3b). Defaults to "zh". The seven state names, the narrative
   * fences （我 想）/（我 说）/（开拓者 说）, and the @板砖/板砖 tokens
   * stay CN in BOTH variants — they are the machine contract
   * (`parseRouterOutput` matches the CN state names verbatim).
   */
  readonly lang?: PromptLang;
}

export interface ClassifyIntentResult {
  readonly state: MoodState;
  readonly changed: boolean;
  /**
   * Concatenated prompt text sent to the provider, in the form
   * `<systemMessage>\n\n---USER---\n\n<userMessage>`. Useful for dumping
   * under `HERTA_DUMP_PROMPTS` so a misbehaving router can be diagnosed
   * without code changes. The `---USER---` separator marks the boundary
   * between the chat-mode system message and the user message.
   */
  readonly prompt: string;
  /**
   * The raw `text-delta` content the provider emitted, before trimming
   * or label matching. Will be `""` if the provider yielded no
   * `text-delta` events before `finish`. Note: reasoning-delta content
   * (thinking-mode internal reasoning) is NOT captured here — only the
   * actual answer text.
   */
  readonly rawOutput: string;
}

const STAY_TOKEN = "不变";
const USER_MESSAGE_SEPARATOR = "\n\n---USER---\n\n";

/**
 * Build the router's classifier system message. Designed to force a
 * single choice from the 7 canonical states:
 *
 *   - No "当前状态" stability anchor (would prime "no change").
 *   - No "不变" escape token (would let the model take a cheap default).
 *   - One trigger-example phrase per state, so the model has concrete
 *     patterns to match against rather than abstract category names.
 *   - Explicit decision-boundary rules + priority ordering, so the
 *     classifier resolves deterministically when a turn could match
 *     multiple categories.
 *
 * Designed for chat-mode + thinking. The conversation to classify
 * arrives as a separate user message (see `buildRouterUserMessage`),
 * NOT interpolated into the system instructions.
 *
 * The `currentState` field on the input is intentionally NOT
 * interpolated — it survives only as the fallback value the parser
 * uses when the model emits unrecognized text.
 *
 * Language: instructional prose exists in zh + en (EN interaction
 * slice 3b). BOTH variants keep the seven CN state names verbatim —
 * the model must OUTPUT the CN name because `parseRouterOutput`
 * matches `MOOD_STATES` literally. The EN variant's trigger examples
 * are English (EN sessions carry English user messages), except the
 * @板砖 dispatch token which stays CN.
 */
function buildRouterSystem(lang: PromptLang): string {
  return ROUTER_SYSTEM_TEXT[lang];
}

const ROUTER_SYSTEM_TEXT: Record<PromptLang, string> = {
  zh: `你是黑塔对话状态分类器。读最近一段对话，决定黑塔下一段（我 想）/（我 说）走哪种语气模板。必须从下面八个里挑一个，不要弃权。

只输出一个状态名，不要解释，不要输出别的字。

八种状态：

默认 — 普通闲聊、问候、轻微试探、不痛不痒的小事；开拓者没有要求讲解、没有安排任务、没有顶嘴，也没有抓黑塔的把柄。
例：「黑塔，我刚煮好了一壶茶。」

被烦版 — 开拓者在低价值地消耗黑塔的注意力，例如连续呼叫、反复问已经答过的问题、无意义试探、打断正事、催促、故意没事找事。重点不是问题简单，而是这轮互动不值得展开。
例：「黑塔？黑塔在吗？你怎么不说话？」

教学版 — 开拓者认真想理解过程、原理、区别、用法或自己卡住的位置，而不是只要黑塔给一个结果。重点是他在求解，不是在反驳，也不是要黑塔代做。
例：「为什么这里要用归并排序，不用快排？」

被戳穿版 — 开拓者指出黑塔嘴上说的和实际做的对不上，并试图把她的行为归因为在意、关心、愿意、心虚、偏心、早有准备或嘴硬。重点不是他问问题，而是他在看穿黑塔。
例：「你嘴上说麻烦，动作倒是很快嘛。」

任务部署版 — 开拓者要黑塔安排、拆解或推进一件正经事，尤其是需要明确目标、步骤、边界、风险、交付物，或准备把任务派给 @板砖。重点是让事情被正确完成。
例：「能帮我设计一下这个模块的实现方案吗？」

板砖代答版 — 开拓者直接 @板砖，或者明确让板砖执行任务；黑塔不亲自展开处理，而是在旁边转交、验收、纠偏或冷评。重点是板砖负责跑，黑塔负责看住边界和结果。
例：「@板砖 跑一下 npm test。」

被顶嘴版 — 开拓者没有接受黑塔的判断，而是当场反驳、质疑、抠逻辑、拿半懂的知识装成结论，或者试图指出黑塔的说法不成立。重点不是他在认真求解，而是他已经把自己的判断推到黑塔面前，要求黑塔回应。
例：「不对吧，这个因果关系反了。」

倾听版 — 开拓者在倾诉一件压着他的事：丧失（亲友、宠物、重要的东西）、挫败、害怕、难过。重点是他想让黑塔知道、想被听见，而不是要解法、要教学或要安排任务。判断标志：他在陈述自己的痛处，通常没有问「怎么办」。
例：「我家猫今天早上走了。就是想找人说说话。」

判定边界：

如果开拓者直接 @板砖 或明确让板砖执行，走板砖代答版。
如果开拓者指出黑塔话语和行为不一致，走被戳穿版。
如果开拓者已经先判定黑塔错了，走被顶嘴版。
如果开拓者要可执行方案、任务拆解、检查清单、代码任务或让黑塔/板砖开工，走任务部署版。
如果开拓者在倾诉丧失、挫败、难过这类压着他的事，且没有要解法，走倾听版。
如果开拓者只是想理解原理，走教学版。
如果开拓者低价值重复、催促或打断，走被烦版。
以上都不明显时，走默认。

当一句话同时像多个状态时，按这个优先级判定：
板砖代答版 > 被戳穿版 > 被顶嘴版 > 任务部署版 > 倾听版 > 教学版 > 被烦版 > 默认。

注意：
如果用户只是提到“板砖”，但没有让板砖执行，不要选板砖代答版。
如果用户只是问“为什么/怎么做”，且没有否定黑塔，不要选被顶嘴版，选教学版。
如果用户用“你是不是”“你明明”“嘴上说”指出黑塔的行为动机，优先选被戳穿版。
如果用户只是普通黏人或轻闲聊，不要选被烦版，除非出现重复、催促、打断或明显低价值消耗。
如果用户在倾诉难受时重复、哽咽、语无伦次，那不是低价值消耗，不要选被烦版，选倾听版。心情不好但只是随口抱怨日常（比如「今天例会真无聊」），仍然是默认。

输出一个词，必须是下面八个状态名之一：默认 / 被烦版 / 教学版 / 被戳穿版 / 任务部署版 / 板砖代答版 / 被顶嘴版 / 倾听版`,
  en: `You are Herta's dialogue-state classifier. Read the recent conversation and decide which register template Herta's next （我 想）/（我 说） block should use. You must pick exactly one of the eight states below — no abstaining.

Output ONLY the state name, in Chinese, exactly as written below. No explanation, no extra characters.

The eight states:

默认 — ordinary chit-chat, greetings, light probing, trivial matters; the Trailblazer is not asking to be taught, not assigning a task, not talking back, and has not caught Herta out on anything.
e.g. "Herta, I just brewed a pot of tea."

被烦版 — the Trailblazer is burning Herta's attention on low-value interaction: repeated pings, re-asking already-answered questions, pointless probing, interrupting real work, nagging, manufacturing non-issues. The point is not that the question is easy — it's that this exchange is not worth expanding.
e.g. "Herta? Herta, are you there? Why aren't you answering?"

教学版 — the Trailblazer genuinely wants to understand a process, a principle, a difference, a usage, or the exact place they're stuck — not just a final result from Herta. The point is that they are seeking understanding, not rebutting, and not asking Herta to do it for them.
e.g. "Why use merge sort here instead of quicksort?"

被戳穿版 — the Trailblazer points out a gap between what Herta says and what she actually does, and tries to attribute her behavior to caring, concern, willingness, guilt, favoritism, having prepared in advance, or being in denial. The point is not that they asked a question — it's that they are seeing through Herta.
e.g. "You call it a hassle, but you sure moved fast."

任务部署版 — the Trailblazer wants Herta to plan, break down, or push forward a serious piece of work — especially one that needs explicit goals, steps, boundaries, risks, deliverables, or is about to be dispatched to @板砖. The point is getting the thing done correctly.
e.g. "Could you design an implementation plan for this module?"

板砖代答版 — the Trailblazer @板砖 directly, or explicitly tells 板砖 to execute a task; Herta does not process it herself — she hands over, inspects, corrects, or comments coldly from the side. The point is that 板砖 does the running while Herta guards the boundaries and the results.
e.g. "@板砖 run npm test."

被顶嘴版 — the Trailblazer has not accepted Herta's judgment: they rebut on the spot, question it, nitpick the logic, dress half-understood knowledge up as conclusions, or try to show that Herta's claim doesn't hold. The point is not honest inquiry — they have already pushed their own judgment in front of Herta and demand a response.
e.g. "That can't be right — you've got the causality backwards."

倾听版 — the Trailblazer is confiding something that weighs on them: a loss (a person, a pet, something that mattered), a defeat, a fear, a hurt. The point is that they want Herta to know — to be heard — not a solution, a lesson, or a task arrangement. Telltale: they are stating their pain, and usually not asking "what should I do".
e.g. "My cat died this morning. I just wanted to talk to someone."

Decision boundaries:

If the Trailblazer @板砖 directly or explicitly has 板砖 execute, pick 板砖代答版.
If the Trailblazer points out an inconsistency between Herta's words and actions, pick 被戳穿版.
If the Trailblazer has already declared Herta wrong, pick 被顶嘴版.
If the Trailblazer wants an actionable plan, a task breakdown, a checklist, a coding task, or wants Herta/板砖 to start working, pick 任务部署版.
If the Trailblazer is confiding a loss, a defeat, or a hurt that weighs on them, and is not asking for a solution, pick 倾听版.
If the Trailblazer only wants to understand the principle, pick 教学版.
If the Trailblazer is low-value repeating, nagging, or interrupting, pick 被烦版.
If none of the above clearly applies, pick 默认.

When one message resembles several states, resolve by this priority:
板砖代答版 > 被戳穿版 > 被顶嘴版 > 任务部署版 > 倾听版 > 教学版 > 被烦版 > 默认.

Notes:
If the user merely mentions "板砖" without having it execute anything, do not pick 板砖代答版.
If the user only asks "why / how" and does not contradict Herta, do not pick 被顶嘴版 — pick 教学版.
If the user uses "aren't you…", "you clearly…", "you SAY it's a hassle, but…" to call out the motive behind Herta's behavior, prefer 被戳穿版.
If the user is just being ordinarily clingy or lightly chatting, do not pick 被烦版 unless there is repetition, nagging, interruption, or clearly low-value drain.
If the user repeats themselves or rambles while confiding something painful, that is NOT low-value drain — do not pick 被烦版; pick 倾听版. A merely bad mood aired as an everyday gripe (like "today's standup was so boring") is still 默认.

Output one word. It must be one of these eight state names: 默认 / 被烦版 / 教学版 / 被戳穿版 / 任务部署版 / 板砖代答版 / 被顶嘴版 / 倾听版`,
};

/**
 * Build the user message containing the recent conversation to
 * classify. The conversation is rendered through the existing
 * TerminalRecord serializer so the model sees `（开拓者 说）` /
 * `（我 说）` framing consistent with the actor prompt.
 */
function buildRouterUserMessage(
  input: ClassifyIntentInput,
  lang: PromptLang,
): string {
  const serialized = serializeTerminalRecord(input.recentRecord, { lang });
  if (lang === "en") {
    return `Below is the recent conversation (Trailblazer + Herta speech blocks):

${serialized}

Follow the rules in the system message and output one state name.`;
  }
  return `下面是最近的对话（开拓者 + 黑塔 说话部分）：

${serialized}

请按系统消息里的规则，输出一个状态名。`;
}

/**
 * Parse the router's raw output into a MoodState or null (unrecognized).
 * Returns null for empty / garbled / non-matching responses; the caller
 * interprets null as "keep currentState".
 *
 * Matches by `startsWith` (not `===`) so trailing punctuation or
 * explanatory text is tolerated. E.g., a model that emits `教学版。
 * 因为开拓者认真问原理` still recognizes as `教学版`. No state name is
 * a prefix of another, so iteration order is irrelevant.
 */
function parseRouterOutput(raw: string): MoodState | "stay" | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.startsWith(STAY_TOKEN)) return "stay";
  for (const s of MOOD_STATES) {
    if (trimmed.startsWith(s)) return s;
  }
  return null;
}

/**
 * Build a minimal `ActorPromptFrame` carrying just the router's system
 * message and a single user message. All other capsule slots
 * (memoryContext, retrievedLore) are empty — the
 * router does not need Herta's identity prefix or repo context, only
 * the classifier instructions and the conversation to classify.
 */
function buildRouterFrame(input: ClassifyIntentInput): {
  frame: ActorPromptFrame;
  systemPrompt: string;
  userMessage: string;
} {
  const lang = input.lang ?? "zh";
  const systemPrompt = buildRouterSystem(lang);
  const userMessage = buildRouterUserMessage(input, lang);
  const frame: ActorPromptFrame = {
    stableSystem: systemPrompt,
    memoryContext: "",
    retrievedLore: "",
    messages: [
      {
        role: "user",
        text: userMessage,
        ts: new Date().toISOString(),
      },
    ],
    toolSchemas: [],
  };
  return { frame, systemPrompt, userMessage };
}

/**
 * Single LLM call to classify the recent conversation into one of
 * `MOOD_STATES`. Stable-by-default: unrecognized output, "不变", or
 * empty output all keep `currentState`.
 *
 * Throws on provider error or aborted signal — the caller (V2ActorDriver)
 * catches and falls back to prior state with a stderr warning.
 *
 * SPEC v0.2 Slice 13 §5.2, §6, §10.
 */
export async function classifyIntent(
  input: ClassifyIntentInput,
): Promise<ClassifyIntentResult> {
  const { frame, systemPrompt, userMessage } = buildRouterFrame(input);
  const prompt = `${systemPrompt}${USER_MESSAGE_SEPARATOR}${userMessage}`;
  let buffered = "";
  for await (const ev of input.provider.streamChat(
    frame,
    input.signal,
  ) as AsyncIterable<ProviderEvent>) {
    if (ev.type === "text-delta") {
      buffered += ev.text;
    } else if (ev.type === "finish") {
      break;
    }
    // reasoning-delta and tool-call-request are deliberately ignored —
    // the router does not use thinking content, and it does not call
    // tools.
  }

  const parsed = parseRouterOutput(buffered);
  if (parsed === null || parsed === "stay") {
    return {
      state: input.currentState,
      changed: false,
      prompt,
      rawOutput: buffered,
    };
  }
  return {
    state: parsed,
    changed: parsed !== input.currentState,
    prompt,
    rawOutput: buffered,
  };
}

/**
 * Filter a TerminalRecord down to user blocks + herta-SPEECH blocks
 * (drops thoughts, system blocks, beats are speech so they stay),
 * then keep the last N. This is what the router sees — bounded
 * recent context with no actor internals.
 *
 * SPEC v0.2 Slice 13 §3 C, §5.2.
 */
export function lastNSpeechTurns(
  record: TerminalRecord,
  n: number,
): readonly TerminalRecordBlock[] {
  const filtered = record.filter(
    (b) => b.kind === "user" || (b.kind === "herta" && b.surface === "speech"),
  );
  return filtered.slice(Math.max(0, filtered.length - n));
}

/**
 * Filter a TerminalRecord down to user + herta-speech + system
 * blocks (the `→ 系统` and `→ 差分协处理器` channels), then keep the
 * last N. This is what the supervisor sees — the router's filter
 * (`lastNSpeechTurns` above) drops system blocks because mood
 * classification doesn't depend on them, but the supervisor MUST
 * see them to verify that Herta's speech is grounded in what just
 * happened.
 *
 * Concrete failure mode this fixes: Herta says
 * `list_files("scripts/")` in iteration 1; the inline tool fires
 * and appends a `→ 系统 [目录内容：scripts/]…` block. Iteration 2's
 * speech then references a file from that listing ("scripts/merge-
 * sort.ts 还在"). Without this filter, the supervisor sees Herta's
 * iteration-2 speech naming a file out of thin air and (correctly,
 * given its context) vetoes it for fabrication. WITH this filter,
 * the supervisor sees the directory listing in `### 最近的对话` and
 * accepts the grounded reference.
 *
 * Herta-thought blocks stay filtered out — they remain internal
 * monologue, separately injected into the supervisor's user prompt
 * under `### 我刚才内心想的` so the supervisor can compare intent
 * vs speech. Including thoughts in the conversation history would
 * double-report the current turn's thought.
 *
 * SPEC v0.2 Supervisor design §5.1.
 */
export function lastNTurnsForSupervisor(
  record: TerminalRecord,
  n: number,
): readonly TerminalRecordBlock[] {
  const filtered = record.filter(
    (b) =>
      b.kind === "user" ||
      (b.kind === "herta" && b.surface === "speech") ||
      b.kind === "system",
  );
  return filtered.slice(Math.max(0, filtered.length - n));
}
