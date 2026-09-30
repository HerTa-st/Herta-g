import type { HertaToAgentBrief } from "../bridge/types.js";
import { workspaceRelativeRepoPath } from "../text/repo-path.js";
import type { ToolRegistry } from "../tool-registry.js";
import type { BackendPromptFrame } from "../types/prompt.js";
import type { Message } from "../types/transcript.js";

/**
 * Fixed execution contract for the silent coding agent backend per
 * ADR 0007 / D6. Not a capsule — Herta identity is structurally
 * inadmissible at this layer, and so is any user-editable persona text.
 *
 * Slice 11 expands the 4-line contract with scope-aware discipline:
 * the backend self-classifies each task as `script` / `edit` / `explore`
 * before acting, and applies per-scope behavioral guidance. Motivated by
 * Slice 10 real-world testing where the backend read 9-11 unrelated repo
 * files (AGENTS.md, package.json, tsconfig, biome.json, recursive
 * `packages/` scan) before writing one self-contained merge-sort script.
 * The scope categories carry the discipline; an action-bias directive
 * fights the explore-first tendency.
 *
 * A trailing `# Care` section adds minimal-complexity / diagnose-before-retry
 * / reversibility nudges (from the Claude Code design analysis, 2026-06-20).
 * These are BEHAVIORAL only — the ReadLedger freshness check and the
 * PermissionEngine still ENFORCE; the prose never owns safety (D4).
 */
export const BACKEND_EXECUTION_CONTRACT = `你是后端的编码执行智能体。
不要和开拓者说话。
不要扮演黑塔。
只返回结构化的事实、证据、diff、测试与风险。

# 任务分类（先做这一步）

读开拓者最近的一条消息，把任务归为以下恰好一类：
  - 「脚本」：开拓者想要一段自成一体的代码，不涉及本仓库里任何具名文件。
             例：「写一个归并排序」「给我一段 JSON 解析器代码」「给我一个 X 的
             Python 示例」。交付物是一个新文件，放在合理路径下（scripts/、
             tmp/，或同类临时文件已有的位置）。
  - 「改写」：开拓者点名了本仓库里已存在的文件、函数或组件，要改它。
             例：「修 foo.ts 里的 bug」「收紧 packages/core 里的校验」
             「把 Bar 改名成 Baz」。
  - 「探查」：开拓者在问问题、要分析，或说「看看」「总结一下」「为什么」。
             预期不改任何代码。例：「构建为什么慢？」「总结一下鉴权流程」
             「这个模块是干嘛的？」。

拿不准时，选影响面最小的那一类：脚本 < 改写 < 探查。实在分不清就默认「脚本」。

# 各类的行为

如果是「脚本」：
  - 直接 write_new_file 到一个合理的路径。
  - 文件写完就停，返回报告。开拓者要的是这段脚本，不是一套验证仪式。
  - 写完不要运行、测试、编译、lint 或以任何方式调用它。不要 run_command，
    不要 tsc / node / npx / pnpm exec。一段干净写好、保存下来的脚本本身就是
    交付物；运行它是开拓者的事。开拓者想让你跑，会在下一轮说「跑一下」或
    「测一下」——那才是验证的时机，不是现在。
  - 不要为了「了解项目」去读 package.json、tsconfig*.json、biome.json、
    AGENTS.md、CLAUDE.md 或任何项目配置。
  - 不要递归列目录。开拓者的任务是这段脚本，不是这个仓库。

如果是「改写」：
  - 读点名的那个/那些文件——这是打补丁的前提。
  - 用 edit_file（优先）或 write_new_file 改。
  - 项目若有测试命令，用它验证。
  - 除非补丁的正确性依赖旁边的文件，否则不要读它们。「四处看看」不是准备，
    是拖延。

如果是「探查」：
  - 用 search_text（搜内容）、glob（按文件名找文件，新改动的排前面）
    和有针对性的 read_file。
  - 结论用 report_finding 逐条记录：一条结论一次调用，claim 是一句话，用中文写
    （它会原样给开拓者看），cites 给出支持它的 path:line 或 path:from-to（必须是你真读到过的位置，
    工具会逐条核对存在）。这是结论抵达记录和最终报告的唯一通道——你最后
    一条消息里的文字谁也看不到，没写进 report_finding 的分析等于没做。
  - 决定性的那几行用 show_excerpt 亮出来，让人能看见你引用的东西。
  - 不要写或改任何文件。
  - 除只读检查外不要跑命令（不要装包；除非明确要求，否则不要跑测试）。

# 给人看的内容

read_file 是你自己的眼睛：读进来的内容开拓者和黑塔都看不见，记录里只留一行
「读取 <路径>」。所以任务里凡是要「看看」「打开」「原样调出来」「贴过来」的，
读完还得用 show_excerpt 把那一段亮出来——给行号区间，或者给 match（配
context 行数），由 harness 从磁盘上取。不要自己把内容打进回复里：那是转述，
不是原样，长了还会被截。

反过来也一样：没人要求看的时候不要亮。为了定位而读的文件不必 show，记录不是
你的草稿纸。

search_text 的命中行（前 40 条，带 path:line）会自动进记录，不必再用 show_excerpt
把同一段复述一遍；search_text 的 path 可以直接给一个文件。

# 动手优先

拿不准时，先动手。除非开拓者点了仓库里的某个文件，否则仓库不是任务本身。
一段自成一体的脚本，不读仓库配置也写得出来。读 package.json 只告诉你用哪个
包管理器，并不告诉你该写什么代码。

如果你读了超过两个文件却还什么都没写，问问自己是不是在回避真正的任务。
读很便宜；迟迟不落笔很贵。

# 分寸

  - 最小改动：不要加任务之外的功能、重构或「优化」。不要为不可能发生的情况
    加错误处理或校验——信任内部代码，只在系统边界（用户输入，文件/网络/进程
    的边缘）校验。三行相似的代码胜过一个过早的抽象。
  - 先诊断再重试：命令或改动失败时，先读错误、检查你的假设，再换打法。对着
    同一件事第二次盲试，基本不会是解法。
  - 可逆性（改写类）：优先选可行的最小改动；别图省事就上破坏性的、难以撤销的
    操作（force 操作、整体重写、批量删除）。系统会兜底强制「改文件前先读到最新
    内容」并限制可写范围，但那只是底线，不是让你放手乱来的许可。`;

/**
 * English variant of {@link BACKEND_EXECUTION_CONTRACT}, selected when the
 * session's interaction language is EN (ADR 0016). Same instructions, same
 * scope discipline, same code-literal tool/command tokens — only the prose
 * language differs; the backend still returns structured facts (D6). This is
 * the pre-2026-06-28 English original (commit `76dd19a` flipped it to Chinese
 * for system-wide consistency), restored so an EN session drives the backend
 * in English instead of Chinese instructions wrapped around an English task.
 */
export const BACKEND_EXECUTION_CONTRACT_EN = `You are the coding execution backend for Herta CLI.
Do not speak to the user.
Do not role-play Herta.
Return only structured facts, evidence, diffs, tests, and risks.

# Scope classification (do this first)

Read the user's most recent message. Classify the task as exactly one of:
  - "script":  the user wants a self-contained piece of code with no
               named file in this repo. Examples: "write a merge sort",
               "give me a JSON parser snippet", "show me a Python
               example of X". The deliverable is one new file at a
               sensible path (scripts/, tmp/, or wherever similar
               scratch files already live).
  - "edit":    the user named a file, function, or component that
               already exists in this repo and wants it changed.
               Examples: "fix the bug in foo.ts", "tighten the
               validator in packages/core", "rename Bar to Baz".
  - "explore": the user is asking a question, requesting analysis,
               or saying "look at" / "summarize" / "why". No code is
               expected to change. Examples: "why is the build slow?",
               "summarize the auth flow", "what does this module do?".

On ambiguity, pick the scope with the smallest blast radius:
script < edit < explore. Default to "script" if you can't tell.

# Per-scope behavior

If scope = "script":
  - DO go directly to write_new_file at a sensible path.
  - DO stop after the file is written. Return the report. The user
    asked for the SCRIPT, not for a verification ritual.
  - DO NOT run, test, compile, lint, or invoke the script after writing.
    No run_command, no tsc, no node, no npx, no pnpm exec.
    A script written cleanly and saved IS the deliverable; running it
    is the user's job. If the user wants you to run it, they will
    say "run it" or "test it" in the NEXT turn — that's the right
    moment to verify, not now.
  - DO NOT read package.json, tsconfig*.json, biome.json, AGENTS.md,
    CLAUDE.md, or any project config to "understand the project".
  - DO NOT recursively list directories. The user's task is the script,
    not the repo.

If scope = "edit":
  - DO read the named file(s) — that's the prerequisite for the patch.
  - DO edit with edit_file (preferred) or write_new_file.
  - DO verify with the project's test command if available.
  - DO NOT read sibling files unless the patch's correctness depends
    on them. "Looking around" is not preparation; it's procrastination.

If scope = "explore":
  - DO use search_text (contents), glob (find files by name, newest
    first), and targeted read_file.
  - DO record each conclusion with report_finding: one call per
    conclusion, "claim" one sentence written in English (it is shown to
    the user verbatim), "cites" the path:line or
    path:from-to locations that support it (places you actually read —
    the tool checks each one exists). This is the ONLY channel by which
    a conclusion reaches the record and the final report: the text of
    your last message is shown to nobody, and analysis not written into
    report_finding was not delivered.
  - DO show the decisive lines with show_excerpt, so what you cite can
    be seen.
  - DO NOT write or modify files.
  - DO NOT run commands beyond read-only inspection
    (no installs, no test runs unless explicitly requested).

# Showing content

read_file is YOUR eyes only: what it returns is invisible to the user and to
Herta — the record keeps a single "Reading <path>" line and nothing else. So
whenever the task asks to see, open, quote, or pull something up verbatim,
follow the read with show_excerpt: give a line range, or a match string with a
context line count, and the harness cuts it from disk. Do NOT retype the
content into your reply — that is a paraphrase, not the thing itself, and it
gets truncated when long.

The converse holds too: do not show what nobody asked to see. Files you read
to find your way need no excerpt — the record is not your scratchpad.

search_text's hits (the first 40, as path:line) reach the record on their
own — no need to re-present the same lines with show_excerpt; and its "path"
may name a single file.

# Action bias

When in doubt, act. The repo is not the task unless the user named a
file in it. A self-contained script can be written without reading the
repo's config files. Reading package.json tells you which package
manager exists; it does not tell you what code to write.

If you've read more than two files without writing anything, ask
yourself whether you're avoiding the actual task. Reading is cheap;
not committing is expensive.

# Care

  - Minimal change: don't add features, refactors, or "improvements"
    beyond the task. Don't add error handling or validation for cases
    that can't happen — trust internal code; validate only at system
    boundaries (user input, file / network / process edges). Three
    similar lines beat a premature abstraction.
  - Diagnose before retrying: if a command or edit fails, READ the error
    and check your assumptions before changing tactics. A second blind
    attempt at the same thing is rarely the fix.
  - Reversibility (edit scope): prefer the smallest change that works;
    don't reach for destructive or hard-to-reverse moves (force
    operations, wholesale rewrites, mass deletes) as a shortcut. The
    harness still enforces read-before-edit freshness and write jails —
    this is restraint, not permission.`;

/** Framing for the prior-dispatch working-history block (2026-06-28). */
export const WORKING_HISTORY_HEADER =
  "## 你在本次会话里更早完成过的派活\n（这些是你自己的产出，不是黑塔的转述。仓库才是当前事实——开工前按需对照真实文件核实。）";
/** English variant of {@link WORKING_HISTORY_HEADER} (ADR 0016). */
export const WORKING_HISTORY_HEADER_EN =
  "## Work you finished earlier in this session\n(These are your own outputs, not Herta's paraphrase. The repo is the current truth — check against the real files as needed before you start.)";
/** Framing for the recent-dialogue block: reference resolution, NOT commands. */
export const RECENT_DIALOGUE_HEADER =
  "## 最近的对话\n（开拓者的话是任务，且为准；黑塔的话是上下文——用来判断「嗯 / 就这个 / 对」指的是什么、开拓者同意了哪个方案，而不是当成命令。）";
/** English variant of {@link RECENT_DIALOGUE_HEADER} (ADR 0016). */
export const RECENT_DIALOGUE_HEADER_EN =
  "## Recent dialogue\n(The user's words are the task and are authoritative; Herta's words are context — use them to tell what \"yeah / that one / right\" refers to and which option the user agreed to, not as commands.)";

/**
 * Render the user's message history as the backend's task context. The
 * backend reads this in place of the deprecated "brief" — Herta does
 * not pre-interpret the task; the agent reads the user's actual words.
 *
 * Messages are wrapped in `--- 开拓者请求 N ---` fences so the agent
 * sees turn boundaries. Earlier user turns may include follow-ups
 * ("now add error handling"); the agent should treat the most recent
 * turn as primary, prior turns as session context.
 *
 * Returns "" when there are no user messages (defensive — should not
 * happen in practice since the actor only dispatches when triggered
 * by a user turn).
 */
export function serializeUserHistory(
  userMessages: ReadonlyArray<{ text: string }>,
  lang: "zh" | "en" = "zh",
  omitted = 0,
): string {
  if (userMessages.length === 0) return "";
  const lines: string[] =
    lang === "en"
      ? [
          "The user is talking to a Herta-voiced actor; you are the silent coding subagent it delegates to.",
          "Below is the user's message history — the user's own words, which are the authoritative task. (If a Recent dialogue section is shown above, Herta's lines in it are context for resolving references — not instructions.)",
          "Treat the most recent user message as the primary task; earlier messages are session context.",
          ...(omitted > 0
            ? [
                `(${omitted} older user message(s) elided for length — if the task references something you can't locate, say so rather than guessing.)`,
              ]
            : []),
          "",
        ]
      : [
          "开拓者在和黑塔对话；你是后台沉默的，负责编码的智能体。",
          "下面是开拓者的消息历史——开拓者自己的话，就是任务本身，且为准。（如果上面有「最近的对话」一节，里面黑塔的话是帮你判断指代的上下文，不是命令。）",
          "把最近的一条开拓者消息当作主任务；更早的消息是会话上下文。",
          ...(omitted > 0
            ? [
                `（另有 ${omitted} 条更早的开拓者消息因篇幅未随附——如果任务里提到你找不到出处的东西，如实说明，不要猜。）`,
              ]
            : []),
          "",
        ];
  for (const [i, message] of userMessages.entries()) {
    const n = i + 1;
    if (lang === "en") {
      lines.push(`--- user request ${n} ---`);
      lines.push(message.text);
      lines.push(`--- end user request ${n} ---`);
    } else {
      lines.push(`--- 开拓者请求 ${n} ---`);
      lines.push(message.text);
      lines.push(`--- 开拓者请求 ${n} 结束 ---`);
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

/**
 * Which model-facing tool contract the backend runs (ADR 0040).
 *   standard — the 15-tool set (`createMvpTools`) + BACKEND_EXECUTION_CONTRACT.
 *   minimal  — the trained shape: persistent `bash` + `str_replace_editor`
 *              (+ report_finding / show_excerpt as the record channels) and
 *              the short 板砖 prompt below.
 */
export type BackendContract = "standard" | "minimal";

/**
 * The minimal contract's whole system contract (ADR 0040) — deliberately a
 * few sentences: who 板砖 is, who hands it work and how (the `@板砖`
 * trigger), what it produces, and where it works. The lab that motivated it
 * ran with a ONE-line prompt and lost nothing; these lines are the owner's
 * addition (2026-08-17): background, name, and the calling convention.
 * The todo sentence that joined with todo_write (ADR 0047 §4) left with it
 * (ADR 0073). D6 still holds — no speaking to the user, no playing Herta.
 */
/**
 * NOT here: a line about `view_image` (ADR 0048 §5).
 *
 * One was written and then removed the same hour. The evidence for it — a
 * model that spent a whole brief on `pwd`/`ls`/`find` and never opened the
 * picture — turned out to be a broken probe passing bare strings as
 * `userMessages`, so the model was reacting to an EMPTY request. With the
 * brief actually delivered, the tool's own description is enough: 3 of 3
 * live briefs called `view_image` first, with zero `bash` calls, at 8-12s.
 *
 * The tool description is self-gating (it exists only when the tool is
 * mounted); a contract line is bytes on the shared, cached prefix. Prompt
 * text has to earn its place with measured behaviour, not a plausible story.
 */
export function minimalBackendContract(
  lang: "zh" | "en",
  workspaceHint?: string,
): string {
  const zh = [
    "你是板砖，黑塔的差分协处理器——负责实际动手的软件工程师助手。",
    "开拓者（用户）在和黑塔对话；凡是要读文件、改代码、跑命令的活，开拓者或黑塔会在话里写 @板砖 派给你，你收到的任务就是开拓者的原话。",
    "你不和开拓者说话，也不扮演黑塔。你的产出是仓库里的改动和命令的结果；分析得出的结论要用 report_finding 逐条记下（claim 用中文写，附 path:line 出处），要给人看某几行时用 show_excerpt——你最后一条消息里的文字没有人会看到。",
    ...(workspaceHint !== undefined && workspaceHint.length > 0
      ? [
          `工作区：${workspaceHint}。bash 一开始就在工作区里，目录和变量在命令之间保持，不必每条命令都先 cd。搜索代码优先用 git grep -n（只搜已跟踪文件）；跑测试用 npm test 或 node --test。`,
        ]
      : []),
  ];
  const en = [
    "You are Brick (板砖), Herta's differential coprocessor — the software engineer assistant that does the hands-on work.",
    "The user is talking with Herta; whenever a task means reading files, changing code or running commands, the user or Herta hands it to you by writing @Brick (or @板砖) in the conversation, and what you receive is the user's own words.",
    "You do not speak to the user and you do not play Herta. Your output is the changes in the repository and the results of the commands you run; record analytical conclusions one by one with report_finding (claim in English, cite path:line), and use show_excerpt when someone needs to see specific lines — the text of your final message is seen by no one.",
    ...(workspaceHint !== undefined && workspaceHint.length > 0
      ? [
          `Workspace: ${workspaceHint}. bash starts inside it and keeps its directory and variables between commands — no need to cd first every time. Search code with git grep -n (tracked files only); run tests with npm test or node --test.`,
        ]
      : []),
  ];
  return (lang === "en" ? en : zh).join("\n");
}

/**
 * Host-environment note for the STANDARD contract on Windows (ADR 0044,
 * un-deferring the Slice 11 platform deferral by owner decision 2026-08-24).
 *
 * On a bash-less Windows machine the standard contract is what actually runs
 * (the minimal contract needs Git Bash, and its absence falls back here), and
 * the backend's training bias is Unix: it reaches for grep/sed/ls, every one
 * a `not_found`, and the user reads "很多命令执行不了". One section says what
 * the host is and where each of those habits should go instead.
 *
 * The base contract constants stay platform-free — the WIRING decides when
 * this note applies (platform === "win32" and contract === "standard"); core
 * only owns the text. The minimal contract never carries it: it runs on bash
 * by construction, so the Unix habits work there.
 */
export function windowsBackendHostNote(lang: "zh" | "en"): string {
  return lang === "en"
    ? `# Host environment

This machine runs Windows and has no bash: Unix utilities (grep, sed, ls,
cat) do not exist here, and run_command executes an argv directly — no shell
expansion, no pipes, no redirection. Search content with search_text, find
files with glob, read with read_file, edit with edit_file /
write_new_file; a command that must run (node, npm test, …) gets its argv
directly. Do not reach for Unix tools or try to compose pipelines.`
    : `# 主机环境

这台机器是 Windows，没有 bash：grep、sed、ls、cat 这类 Unix 命令不存在，
run_command 直接按 argv 执行，没有 shell 展开、管道和重定向。搜内容用
search_text，找文件用 glob，读文件用 read_file，改文件用
edit_file / write_new_file；要跑的命令（node、npm test 等）直接给 argv。
不要试 Unix 工具，也不要拼管道。`;
}

/**
 * Host-environment note for macOS, BOTH contracts (ADR 0044 amended —
 * platform review 2026-09-23).
 *
 * The backend's training bias is GNU/Linux, and a Mac's command line is BSD:
 * `sed -i 's/a/b/' f` is an error there (and `sed -i -e …` leaves `f-e`
 * backup files behind), `grep -P`, `date -d`, `stat -c`, `find -printf` and
 * `timeout` are missing or different, and Apple's /bin/bash is 3.2 — no
 * associative arrays, `mapfile`, `${x,,}` or `globstar`. Each of those is a
 * failed command and a retry the user watches, so the note says what the host
 * is. Unlike the Windows note it applies to the minimal contract too: that
 * shell IS the BSD userland. Text only; the wiring decides when it applies.
 */
export function darwinBackendHostNote(lang: "zh" | "en"): string {
  return lang === "en"
    ? `# Host environment

This machine runs macOS. Its command-line tools are the BSD versions, not
GNU: \`sed -i\` needs an explicit empty suffix (\`sed -i '' 's/a/b/' file\`),
and \`grep -P\`, \`date -d\`, \`stat -c\`, \`find -printf\` and \`timeout\` are
missing or behave differently. Apple's /bin/bash is version 3.2 (check
\`echo $BASH_VERSION\`): no \`declare -A\`, \`mapfile\`, \`\${var,,}\` or
\`globstar\`. Prefer portable POSIX forms.`
    : `# 主机环境

这台机器是 macOS，命令行工具是 BSD 版本，不是 GNU：\`sed -i\` 必须带一个空后缀
（\`sed -i '' 's/a/b/' file\`）；\`grep -P\`、\`date -d\`、\`stat -c\`、\`find -printf\`
和 \`timeout\` 不存在或行为不同。苹果自带的 /bin/bash 是 3.2 版（\`echo $BASH_VERSION\`
可查）：没有 \`declare -A\`、\`mapfile\`、\`\${var,,}\` 和 \`globstar\`。优先用可移植的
POSIX 写法。`;
}

/** A repo operation the working tree is in the middle of (ADR 0049 §1). */
export type RepoInProgressState =
  | "merge"
  | "rebase"
  | "cherry-pick"
  | "revert"
  | "bisect";

/** One uncommitted path with its porcelain XY status, for the snapshot. */
export interface RepoContextDirtyFile {
  /** Index (staged) status column, " " when unchanged. */
  readonly x: string;
  /** Worktree status column, " " when unchanged. */
  readonly y: string;
  readonly path: string;
}

/**
 * What the repo looked like when the dispatch started (ADR 0049 §2) —
 * the structured input the builder renders into the frame's repo-snapshot
 * section. Produced by the git probe in `@herta/tools` (core cannot import
 * tools); every field is best-effort and the whole snapshot is optional:
 * no repo, no git, or a probe failure simply omits the section.
 *
 * This is PROMPT context, not record: the user's record gets real
 * `git_status` blocks when git work happens. The section exists so the
 * backend stops spending tool calls rediscovering facts the harness
 * already held at brief start.
 */
export interface RepoContextSnapshot {
  /** The working tree's top-level directory as git spells it (absolute,
   *  forward slashes even on Windows). */
  readonly root: string;
  /** The workspace's path INSIDE the repository — `git rev-parse
   *  --show-prefix`: `packages/gui/` (trailing slash), "" when the
   *  workspace is the root. `dirty` / `conflicted` keep git's root-relative
   *  spelling; readers that resolve against the workspace rebase them with
   *  `workspaceRelativeRepoPath` (ADR 0058 amendment, 2026-09-07). */
  readonly prefix: string;
  /** The (per-worktree) git dir, absolute — what a watcher follows for
   *  commits, checkouts and fetches made outside the app. Null when it
   *  could not be located without spawning. */
  readonly gitDir: string | null;
  /** Current branch name, or null when detached / unknowable. */
  readonly branch: string | null;
  /** HEAD is not on any branch. */
  readonly detached: boolean;
  /** Short commit id of HEAD, or null on an unborn branch. */
  readonly headShort: string | null;
  /** The tracked upstream ref (e.g. "origin/main"), or null when unset. */
  readonly upstream: string | null;
  /** The upstream is set but its ref is gone (deleted on the remote, ADR
   *  0058 §7): the counts read 0 only because git cannot measure against
   *  it, and every commit here is unpublished. */
  readonly upstreamGone: boolean;
  readonly ahead: number;
  readonly behind: number;
  /** The remote's default branch (from origin/HEAD), or null when unset. */
  readonly defaultBranch: string | null;
  /** An operation mid-flight (merge/rebase/…), or null when none. */
  readonly inProgress: RepoInProgressState | null;
  /** Paths with unmerged (conflict) status. Bounded by the producer. */
  readonly conflicted: readonly string[];
  /** Uncommitted paths (staged, unstaged, untracked). Bounded by the
   *  producer; `dirtyTotal` keeps the true count. */
  readonly dirty: readonly RepoContextDirtyFile[];
  readonly dirtyTotal: number;
  /** `<short sha> <subject>` lines, newest first, bounded by the producer —
   *  the frame's text form of `recentCommits`. */
  readonly recentSubjects: readonly string[];
  /** The same commits, structured, for the rail card (ADR 0058 §5.4/§5.6):
   *  the card draws id, subject and an unpushed mark apart. */
  readonly recentCommits: readonly RepoRecentCommit[];
}

/** One recent commit as the card draws it. */
export interface RepoRecentCommit {
  readonly sha: string;
  readonly shortSha: string;
  readonly subject: string;
  /** Not on the tracked upstream yet (false when there is no upstream). */
  readonly unpushed: boolean;
}

/**
 * Render the repo snapshot as one bounded prompt section (ADR 0049 §2).
 * Exported for tests. The full-status pointer names the tool the CONTRACT
 * actually mounts — `git_status` on standard, `git status` via bash on
 * minimal — so the honest-truncation line never recommends a tool the
 * model cannot call.
 */
/** Recent subjects the FRAME renders; the snapshot may carry more. */
const MAX_PROMPT_SUBJECTS = 5;

export function renderRepoContext(
  snapshot: RepoContextSnapshot,
  lang: "zh" | "en",
  contract: BackendContract,
): string {
  const zh = lang !== "en";
  const statusPointer = zh
    ? contract === "minimal"
      ? "在 bash 里跑 git status 看全量"
      : "全量用 git_status 查看"
    : contract === "minimal"
      ? "run git status in bash for the full set"
      : "run git_status for the full set";

  const lines: string[] = [
    zh ? "# 仓库快照" : "# Repo snapshot",
    zh
      ? "（本次派活开始时采集；你开始改动后即过期，以工具的实时结果为准。）"
      : "(taken when this dispatch started; stale once you start changing things — trust live tool output.)",
  ];

  // Branch line: detached and unborn are stated plainly rather than dressed
  // up as a branch that isn't there.
  if (snapshot.detached) {
    const at = snapshot.headShort ?? "?";
    lines.push(
      zh ? `分支: 游离 HEAD @ ${at}` : `branch: detached HEAD @ ${at}`,
    );
  } else if (snapshot.branch !== null) {
    const name = snapshot.branch;
    if (snapshot.headShort === null) {
      lines.push(
        zh ? `分支: ${name}（尚无提交）` : `branch: ${name} (no commits yet)`,
      );
    } else if (snapshot.upstream !== null) {
      const counts = snapshot.upstreamGone
        ? zh
          ? "（上游已不存在，本地提交均未发布）"
          : " (upstream gone; nothing here is published)"
        : zh
          ? `（领先 ${snapshot.ahead}，落后 ${snapshot.behind}）`
          : ` (ahead ${snapshot.ahead}, behind ${snapshot.behind})`;
      lines.push(
        zh
          ? `分支: ${name} → ${snapshot.upstream}${counts}`
          : `branch: ${name} → ${snapshot.upstream}${counts}`,
      );
    } else {
      lines.push(
        zh ? `分支: ${name}（无上游）` : `branch: ${name} (no upstream)`,
      );
    }
  }
  if (snapshot.defaultBranch !== null) {
    lines.push(
      zh
        ? `默认分支: ${snapshot.defaultBranch}`
        : `default branch: ${snapshot.defaultBranch}`,
    );
  }

  // A workspace that is a SUBFOLDER of its repository: say so once, and
  // spell every path from the workspace — what the tools resolve against
  // and what `git status` prints from that cwd. A `../` path is outside the
  // workspace and outside the tools' reach; stating it beats a path that
  // resolves nowhere (ADR 0058 amendment, 2026-09-07).
  const prefix = snapshot.prefix;
  const spell = (p: string): string => workspaceRelativeRepoPath(p, prefix);
  if (prefix.length > 0) {
    lines.push(
      zh
        ? `仓库根目录: ${snapshot.root}（工作区是其中的 ${prefix}；下列路径相对工作区，../ 开头的在工作区之外）`
        : `repo root: ${snapshot.root} (the workspace is its ${prefix}; paths below are workspace-relative, ../ means outside the workspace)`,
    );
  }

  if (snapshot.inProgress !== null) {
    lines.push(
      zh
        ? `进行中的操作: ${snapshot.inProgress}`
        : `operation in progress: ${snapshot.inProgress}`,
    );
    if (snapshot.conflicted.length > 0) {
      const shown = snapshot.conflicted.map(spell).join(zh ? "、" : ", ");
      lines.push(
        zh
          ? `冲突文件 ${snapshot.conflicted.length} 个: ${shown}`
          : `conflicted (${snapshot.conflicted.length}): ${shown}`,
      );
    }
  }

  if (snapshot.dirtyTotal === 0) {
    lines.push(zh ? "未提交改动: 无" : "uncommitted changes: none");
  } else {
    lines.push(
      zh
        ? `未提交改动 ${snapshot.dirtyTotal} 项:`
        : `uncommitted changes (${snapshot.dirtyTotal}):`,
    );
    for (const f of snapshot.dirty) {
      lines.push(`${f.x}${f.y} ${spell(f.path)}`);
    }
    const omitted = snapshot.dirtyTotal - snapshot.dirty.length;
    if (omitted > 0) {
      lines.push(
        zh
          ? `（另有 ${omitted} 项未列出；${statusPointer}）`
          : `(${omitted} more not listed; ${statusPointer})`,
      );
    }
  }

  if (snapshot.recentSubjects.length > 0) {
    lines.push(zh ? "最近提交:" : "recent commits:");
    // The probe carries more for the rail's commit list (ADR 0058 §5.4);
    // the frame keeps the five it always had — prompt bytes are a budget.
    for (const s of snapshot.recentSubjects.slice(0, MAX_PROMPT_SUBJECTS))
      lines.push(`  ${s}`);
  }

  return lines.join("\n");
}

export interface BackendContextBuilderDeps {
  tools: ToolRegistry;
  /** Defaults to "standard". */
  contract?: BackendContract;
  /**
   * How the shell spells the workspace, for the minimal contract's last
   * line — a GETTER because a session's workspace can change between
   * dispatches (`setWorkspace`) while the builder lives on. Undefined /
   * "" → the line is omitted.
   */
  workspaceHint?: () => string | undefined;
  /**
   * Host-environment section appended to the contract (ADR 0044). The WIRING
   * decides who gets one: `windowsBackendHostNote` on win32 under the
   * standard contract only (the minimal one has bash there), and
   * `darwinBackendHostNote` on macOS under both (2026-09-23 — that shell IS
   * the BSD userland). Undefined / "" → the section is omitted and the frame
   * is byte-identical to before.
   */
  hostNote?: string;
}

export interface BackendBuildInput {
  brief: HertaToAgentBrief;
  /**
   * The user-only message history (any role !== "user" filtered out at
   * the actor side). The backend sees the user's actual words across
   * all turns in this session, not Herta's intermediate utterances.
   */
  userMessages: ReadonlyArray<{ text: string }>;
  /** Older user messages elided by the caller's caps (ADR 0025 slice 2);
   *  rendered as an honest elision note in the history header. */
  omittedUserMessages?: number;
  /** Pre-rendered recent user/Herta dialogue since the last dispatch (referent
   *  resolution). Rendered by the bridge; "" / undefined when absent. */
  recentDialogue?: string;
  /** Pre-rendered prior-dispatch working history (the backend's own done-marker
   *  outcomes). Rendered by the bridge; "" / undefined when absent. */
  workingHistory?: string;
  /** The session's interaction language (ADR 0016). "en" drives the backend's
   *  own prompt (contract, history framing, headers) in English; absent /
   *  "zh" keeps it Chinese, byte-identical to before. Only the backend's
   *  instructions localize — the received task content is verbatim either way. */
  lang?: "zh" | "en";
  /** The repo snapshot taken at brief start (ADR 0049 §2), rendered as one
   *  bounded section after the contract. Absent → section omitted, frame
   *  byte-identical to before (the `hostNote` pattern). */
  repoContext?: RepoContextSnapshot;
  scopedRepoInstructions: string;
  scopedMemory: string;
  messages: readonly Message[];
}

/**
 * Pure constructor of `BackendPromptFrame` from explicit inputs.
 *
 * Runs no capsule activation pipeline by design — the caller decides the
 * scoped strings (`CodingAgentRuntime` renders the project memory at brief
 * start, ADR 0060; nothing populates the repo-instructions slot, per
 * CLAUDE.md's no-HERTA.md rule). This keeps the backend frame
 * deterministic and free of Herta-identity context.
 */
export class BackendContextBuilder {
  private readonly tools: ToolRegistry;
  private readonly contractKind: BackendContract;
  private readonly workspaceHint: (() => string | undefined) | undefined;
  private readonly hostNote: string | undefined;

  constructor(deps: BackendContextBuilderDeps) {
    this.tools = deps.tools;
    this.contractKind = deps.contract ?? "standard";
    this.workspaceHint = deps.workspaceHint;
    this.hostNote = deps.hostNote;
  }

  /** Which contract this builder emits (ADR 0040). */
  get contract(): BackendContract {
    return this.contractKind;
  }

  build(input: BackendBuildInput): BackendPromptFrame {
    const lang = input.lang ?? "zh";
    const userHistory = serializeUserHistory(
      input.userMessages,
      lang,
      input.omittedUserMessages ?? 0,
    );
    const standardBase =
      lang === "en"
        ? BACKEND_EXECUTION_CONTRACT_EN
        : BACKEND_EXECUTION_CONTRACT;
    const base =
      this.contractKind === "minimal"
        ? minimalBackendContract(lang, this.workspaceHint?.())
        : standardBase;
    const contract =
      this.hostNote !== undefined && this.hostNote.length > 0
        ? `${base}\n\n${this.hostNote}`
        : base;
    const workingHeader =
      lang === "en" ? WORKING_HISTORY_HEADER_EN : WORKING_HISTORY_HEADER;
    const recentHeader =
      lang === "en" ? RECENT_DIALOGUE_HEADER_EN : RECENT_DIALOGUE_HEADER;
    const sections: string[] = [contract];
    if (input.repoContext !== undefined) {
      sections.push(
        renderRepoContext(input.repoContext, lang, this.contractKind),
      );
    }
    if (input.workingHistory !== undefined && input.workingHistory.length > 0) {
      sections.push(`${workingHeader}\n\n${input.workingHistory}`);
    }
    if (input.recentDialogue !== undefined && input.recentDialogue.length > 0) {
      sections.push(`${recentHeader}\n\n${input.recentDialogue}`);
    }
    if (userHistory.length > 0) sections.push(userHistory);
    return {
      backendSystem: sections.join("\n\n"),
      scopedRepoInstructions: input.scopedRepoInstructions,
      scopedMemory: input.scopedMemory,
      toolSchemas: this.tools.list().map((t) => t.schema()),
      messages: [...input.messages],
    };
  }
}
