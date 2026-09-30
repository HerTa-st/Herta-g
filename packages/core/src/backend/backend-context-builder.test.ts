import { describe, expect, it } from "vitest";
import type { HertaToAgentBrief } from "../bridge/types.js";
import { InMemoryToolRegistry } from "../tool-registry.js";
import {
  BACKEND_EXECUTION_CONTRACT,
  BACKEND_EXECUTION_CONTRACT_EN,
  BackendContextBuilder,
  darwinBackendHostNote,
  minimalBackendContract,
  RECENT_DIALOGUE_HEADER,
  RECENT_DIALOGUE_HEADER_EN,
  type RepoContextSnapshot,
  renderRepoContext,
  serializeUserHistory,
  WORKING_HISTORY_HEADER,
  WORKING_HISTORY_HEADER_EN,
  windowsBackendHostNote,
} from "./backend-context-builder.js";

const sampleBrief: HertaToAgentBrief = { taskId: "t-1" };
const sampleUserMessages = [
  { text: "look at the repo" },
  { text: "fix the failing parser test" },
];

describe("BACKEND_EXECUTION_CONTRACT", () => {
  it("is a non-empty string mentioning the backend role", () => {
    expect(BACKEND_EXECUTION_CONTRACT.length).toBeGreaterThan(0);
    expect(BACKEND_EXECUTION_CONTRACT).toContain("后端");
  });

  it("instructs the model not to role-play Herta and not to address the user", () => {
    expect(BACKEND_EXECUTION_CONTRACT).toMatch(/不要扮演黑塔/);
    expect(BACKEND_EXECUTION_CONTRACT).toMatch(/不要和开拓者说话/);
  });

  // -- Slice 11: scope-aware discipline --

  it("opens with the four original-contract lines in order (identity invariants)", () => {
    const head = BACKEND_EXECUTION_CONTRACT.slice(0, 400);
    const lines = head.split("\n");
    expect(lines[0]).toBe("你是后端的编码执行智能体。");
    expect(lines[1]).toBe("不要和开拓者说话。");
    expect(lines[2]).toBe("不要扮演黑塔。");
    expect(lines[3]).toBe("只返回结构化的事实、证据、diff、测试与风险。");
  });

  it("contains a # Scope classification heading and the three scope labels", () => {
    expect(BACKEND_EXECUTION_CONTRACT).toContain("# 任务分类");
    expect(BACKEND_EXECUTION_CONTRACT).toContain("「脚本」");
    expect(BACKEND_EXECUTION_CONTRACT).toContain("「改写」");
    expect(BACKEND_EXECUTION_CONTRACT).toContain("「探查」");
  });

  it("states the ambiguity tie-breaker (default to script, smallest blast radius)", () => {
    expect(BACKEND_EXECUTION_CONTRACT).toMatch(/影响面最小/);
    expect(BACKEND_EXECUTION_CONTRACT).toMatch(/默认「脚本」/);
  });

  it("contains the per-scope behavior section with do/do-not for each scope", () => {
    expect(BACKEND_EXECUTION_CONTRACT).toContain("# 各类的行为");
    // Script scope: forbidden reads named explicitly.
    expect(BACKEND_EXECUTION_CONTRACT).toContain("package.json");
    expect(BACKEND_EXECUTION_CONTRACT).toContain("AGENTS.md");
    expect(BACKEND_EXECUTION_CONTRACT).toContain("CLAUDE.md");
    // Edit scope: read target, patch, verify.
    expect(BACKEND_EXECUTION_CONTRACT).toMatch(/edit_file/i);
    // Explore scope: read-only.
    expect(BACKEND_EXECUTION_CONTRACT).toMatch(/search_text/i);
  });

  it("forbids running / testing / compiling on script scope (write-and-stop rule)", () => {
    // Regression guard for the Slice 12 "stop after write" rule. The
    // backend used to be told to "DO verify with run_command" for
    // script tasks, which led to a multi-attempt run/test spiral
    // (npx → cmd /c npx → pnpm exec tsx → tsc + node → multiple
    // stdin variants) on a freshly-written merge-sort script. The
    // contract now explicitly forbids post-write execution for
    // script scope and reserves verification for the user's NEXT
    // turn (if they ask for it).
    expect(BACKEND_EXECUTION_CONTRACT).toMatch(/不要运行、测试、编译/);
    expect(BACKEND_EXECUTION_CONTRACT).toMatch(/本身就是\s*交付物/);
    const scriptSectionMatch = BACKEND_EXECUTION_CONTRACT.match(
      /如果是「脚本」：([\s\S]*?)如果是「改写」：/,
    );
    expect(scriptSectionMatch).not.toBeNull();
    const scriptSection = scriptSectionMatch?.[1] ?? "";
    expect(scriptSection).not.toMatch(/run_command\s*验证/);
    expect(scriptSection).not.toMatch(/用\s*run_command/);
  });

  it("contains the # Action bias section with the 'when in doubt, act' directive", () => {
    expect(BACKEND_EXECUTION_CONTRACT).toContain("# 动手优先");
    expect(BACKEND_EXECUTION_CONTRACT).toMatch(/拿不准时，先动手/);
  });

  it("contains the 'more than two files' self-check trigger", () => {
    expect(BACKEND_EXECUTION_CONTRACT).toMatch(/超过两个文件/);
  });

  // -- Care nudges (CC design analysis, 2026-06-20) --

  it("contains a # Care section with minimal-complexity, diagnose-before-retry, and reversibility guidance", () => {
    expect(BACKEND_EXECUTION_CONTRACT).toContain("# 分寸");
    expect(BACKEND_EXECUTION_CONTRACT).toMatch(/只在系统边界[\s\S]*校验/);
    expect(BACKEND_EXECUTION_CONTRACT).toMatch(/先诊断再重试/);
    expect(BACKEND_EXECUTION_CONTRACT).toMatch(/可逆性/);
  });

  it("frames care as restraint, not a safety gate (the harness still enforces — D4)", () => {
    expect(BACKEND_EXECUTION_CONTRACT).toMatch(/系统会兜底强制/);
    expect(BACKEND_EXECUTION_CONTRACT).toMatch(/不是让你放手乱来的许可/);
  });

  // -- Negative assertions: deferred features must NOT leak in --

  it("stays platform-free as a CONSTANT (ADR 0044: the platform note is injected by the wiring on win32, never baked in here)", () => {
    expect(BACKEND_EXECUTION_CONTRACT).not.toMatch(/cmd \/c/i);
    expect(BACKEND_EXECUTION_CONTRACT).not.toMatch(/windows/i);
    expect(BACKEND_EXECUTION_CONTRACT).not.toMatch(/darwin/i);
    expect(BACKEND_EXECUTION_CONTRACT).not.toMatch(/linux/i);
    expect(BACKEND_EXECUTION_CONTRACT).not.toMatch(/\.cmd shim/i);
  });

  it("does not impose a numeric read budget (Slice 11 defers budget enforcement)", () => {
    expect(BACKEND_EXECUTION_CONTRACT).not.toMatch(/read budget/i);
    expect(BACKEND_EXECUTION_CONTRACT).not.toMatch(/budget exhausted/i);
  });
});

describe("serializeUserHistory", () => {
  it("renders each user message under a numbered fence", () => {
    const text = serializeUserHistory(sampleUserMessages);
    expect(text).toContain("look at the repo");
    expect(text).toContain("fix the failing parser test");
    expect(text).toMatch(/--- 开拓者请求 1 ---/);
    expect(text).toMatch(/--- 开拓者请求 2 ---/);
  });

  it("instructs the backend to treat the latest message as primary", () => {
    const text = serializeUserHistory(sampleUserMessages);
    expect(text).toMatch(/最近的一条开拓者消息/);
  });

  it("frames the user history as the authoritative task", () => {
    const text = serializeUserHistory(sampleUserMessages);
    expect(text).toMatch(/任务本身/);
  });

  it("returns empty string for empty input", () => {
    expect(serializeUserHistory([])).toBe("");
  });

  it("is deterministic across calls", () => {
    expect(serializeUserHistory(sampleUserMessages)).toBe(
      serializeUserHistory(sampleUserMessages),
    );
  });

  it("renders an honest elision note when older messages were capped (ADR 0025 slice 2)", () => {
    const zh = serializeUserHistory(sampleUserMessages, "zh", 6);
    expect(zh).toContain("另有 6 条更早的开拓者消息因篇幅未随附");
    expect(zh).toContain("不要猜");
    const en = serializeUserHistory(sampleUserMessages, "en", 6);
    expect(en).toContain("6 older user message(s) elided for length");
    // No note when nothing was elided — byte-identical to the old output.
    expect(serializeUserHistory(sampleUserMessages, "zh", 0)).toBe(
      serializeUserHistory(sampleUserMessages),
    );
  });
});

describe("BackendContextBuilder", () => {
  it("builds a frame containing the execution contract and user history", () => {
    const tools = new InMemoryToolRegistry();
    const builder = new BackendContextBuilder({ tools });

    const frame = builder.build({
      brief: sampleBrief,
      userMessages: sampleUserMessages,
      scopedRepoInstructions: "Repo prefers edit_file over write_new_file.",
      scopedMemory: "User dislikes overlong replies.",
      messages: [],
    });

    expect(frame.backendSystem).toContain(BACKEND_EXECUTION_CONTRACT);
    expect(frame.backendSystem).toContain("fix the failing parser test");
    expect(frame.scopedRepoInstructions).toBe(
      "Repo prefers edit_file over write_new_file.",
    );
    expect(frame.scopedMemory).toBe("User dislikes overlong replies.");
    expect(frame.messages).toEqual([]);
    expect(frame.toolSchemas).toEqual([]);
  });

  it("returns a fresh frame on every build call", () => {
    const tools = new InMemoryToolRegistry();
    const builder = new BackendContextBuilder({ tools });

    const a = builder.build({
      brief: sampleBrief,
      userMessages: sampleUserMessages,
      scopedRepoInstructions: "",
      scopedMemory: "",
      messages: [],
    });
    const b = builder.build({
      brief: sampleBrief,
      userMessages: sampleUserMessages,
      scopedRepoInstructions: "",
      scopedMemory: "",
      messages: [],
    });

    expect(a).not.toBe(b);
    expect(a.toolSchemas).not.toBe(b.toolSchemas);
    expect(a.messages).not.toBe(b.messages);
  });

  it("forwards tool schemas from the registry", () => {
    const tools = new InMemoryToolRegistry();
    tools.register({
      name: "read_file",
      schema: () => ({
        name: "read_file",
        description: "Read a file from the workspace",
        inputSchema: { type: "object", properties: {} },
      }),
      run: async () => ({
        ok: true,
        summary: "",
      }),
    });

    const builder = new BackendContextBuilder({ tools });
    const frame = builder.build({
      brief: sampleBrief,
      userMessages: sampleUserMessages,
      scopedRepoInstructions: "",
      scopedMemory: "",
      messages: [],
    });

    expect(frame.toolSchemas).toHaveLength(1);
    expect(frame.toolSchemas[0]?.name).toBe("read_file");
  });

  it("emits contract-only backendSystem when userMessages is empty", () => {
    const tools = new InMemoryToolRegistry();
    const builder = new BackendContextBuilder({ tools });
    const frame = builder.build({
      brief: sampleBrief,
      userMessages: [],
      scopedRepoInstructions: "",
      scopedMemory: "",
      messages: [],
    });
    expect(frame.backendSystem).toBe(BACKEND_EXECUTION_CONTRACT);
  });

  it("with no dialogue/history, the system prompt is byte-identical to contract + user history", () => {
    const builder = new BackendContextBuilder({
      tools: new InMemoryToolRegistry(),
    });
    const frame = builder.build({
      brief: sampleBrief,
      userMessages: sampleUserMessages,
      scopedRepoInstructions: "",
      scopedMemory: "",
      messages: [],
    });
    expect(frame.backendSystem).toBe(
      `${BACKEND_EXECUTION_CONTRACT}\n\n${serializeUserHistory(sampleUserMessages)}`,
    );
  });

  it("splices working history and recent dialogue, in order, each under its header", () => {
    const builder = new BackendContextBuilder({
      tools: new InMemoryToolRegistry(),
    });
    const frame = builder.build({
      brief: sampleBrief,
      userMessages: sampleUserMessages,
      scopedRepoInstructions: "",
      scopedMemory: "",
      messages: [],
      workingHistory: "完成 · 1 file\n↳ 改动文件: auth.ts",
      recentDialogue: "黑塔：要我加缓存吗？\n\n开拓者：好",
    });
    const sys = frame.backendSystem;
    const iContract = sys.indexOf(BACKEND_EXECUTION_CONTRACT);
    const iHist = sys.indexOf(WORKING_HISTORY_HEADER);
    const iDialogue = sys.indexOf(RECENT_DIALOGUE_HEADER);
    const iUser = sys.indexOf("--- 开拓者请求 1 ---");
    expect(iContract).toBeGreaterThanOrEqual(0);
    expect(iHist).toBeGreaterThan(iContract);
    expect(iDialogue).toBeGreaterThan(iHist);
    expect(iUser).toBeGreaterThan(iDialogue);
    expect(sys).toContain("完成 · 1 file");
    expect(sys).toContain("要我加缓存吗？");
  });

  it("omits a header whose content is empty", () => {
    const builder = new BackendContextBuilder({
      tools: new InMemoryToolRegistry(),
    });
    const frame = builder.build({
      brief: sampleBrief,
      userMessages: sampleUserMessages,
      scopedRepoInstructions: "",
      scopedMemory: "",
      messages: [],
      workingHistory: "",
      recentDialogue: "开拓者：do it",
    });
    expect(frame.backendSystem).not.toContain(WORKING_HISTORY_HEADER);
    expect(frame.backendSystem).toContain(RECENT_DIALOGUE_HEADER);
  });

  it("frames working history as the backend's own output (repo is truth) and dialogue as context, not commands", () => {
    expect(WORKING_HISTORY_HEADER).toMatch(/仓库/);
    expect(RECENT_DIALOGUE_HEADER).toMatch(/不是当成命令|不是命令/);
  });
});

describe("prompt separation invariants", () => {
  const tools = new InMemoryToolRegistry();
  const builder = new BackendContextBuilder({ tools });
  const frame = builder.build({
    brief: sampleBrief,
    userMessages: sampleUserMessages,
    scopedRepoInstructions: "scoped repo only",
    scopedMemory: "scoped memory only",
    messages: [],
  });

  // Sentinels for actor-only IDENTITY / voice / lore context that must never
  // reach the backend (D6). NOTE: the Chinese contract legitimately names 黑塔
  // in its "不要扮演黑塔" guard line and the user-history framing says the user
  // talks to 黑塔 — neither is an identity leak, so the bare-string 黑塔 check is
  // intentionally NOT a sentinel here. The specific identity markers below still
  // guard real persona/voice/lore leaks.
  const HERTA_SENTINELS = [
    "Herta identity",
    "Herta voice",
    "Herta lore",
    "retrievedLore",
    "relationship state",
    "dialogue example",
    "few-shot",
    "herta_core_identity",
    "herta_coding_behavior",
    "final_response_policy",
  ];

  for (const s of HERTA_SENTINELS) {
    it(`backend frame's backendSystem does not contain "${s}"`, () => {
      expect(frame.backendSystem.toLowerCase()).not.toContain(s.toLowerCase());
    });
  }

  it("backend frame has no retrievedLore field", () => {
    expect("retrievedLore" in frame).toBe(false);
  });

  it("backend frame has no stableSystem field", () => {
    expect("stableSystem" in frame).toBe(false);
  });

  it("backendSystem starts with the execution contract, not an identity preamble", () => {
    expect(frame.backendSystem.startsWith("你是后端的编码执行智能体")).toBe(
      true,
    );
  });

  it("backendSystem includes the user's actual words from history", () => {
    expect(frame.backendSystem).toContain("fix the failing parser test");
  });
});

describe("EN backend prompt (ADR 0016)", () => {
  it("BACKEND_EXECUTION_CONTRACT_EN opens with the four English identity lines", () => {
    const lines = BACKEND_EXECUTION_CONTRACT_EN.split("\n");
    expect(lines[0]).toBe(
      "You are the coding execution backend for Herta CLI.",
    );
    expect(lines[1]).toBe("Do not speak to the user.");
    expect(lines[2]).toBe("Do not role-play Herta.");
    expect(lines[3]).toBe(
      "Return only structured facts, evidence, diffs, tests, and risks.",
    );
  });

  it("carries the same scope discipline in English (sections + labels)", () => {
    expect(BACKEND_EXECUTION_CONTRACT_EN).toContain("# Scope classification");
    expect(BACKEND_EXECUTION_CONTRACT_EN).toContain("# Per-scope behavior");
    expect(BACKEND_EXECUTION_CONTRACT_EN).toContain("# Action bias");
    expect(BACKEND_EXECUTION_CONTRACT_EN).toContain("# Care");
    expect(BACKEND_EXECUTION_CONTRACT_EN).toMatch(/"script"/);
    expect(BACKEND_EXECUTION_CONTRACT_EN).toMatch(/"edit"/);
    expect(BACKEND_EXECUTION_CONTRACT_EN).toMatch(/"explore"/);
  });

  it("keeps code-literal tool + command tokens verbatim (not translated)", () => {
    for (const tok of [
      "write_new_file",
      "edit_file",
      "read_file",
      "search_text",
      "glob",
      "run_command",
      "package.json",
      "AGENTS.md",
      "CLAUDE.md",
      "tsc",
      "pnpm exec",
    ]) {
      expect(BACKEND_EXECUTION_CONTRACT_EN).toContain(tok);
    }
  });

  it("EN prose contains no CJK (fully English contract + headers)", () => {
    expect(BACKEND_EXECUTION_CONTRACT_EN).not.toMatch(/[一-鿿]/);
    expect(WORKING_HISTORY_HEADER_EN).not.toMatch(/[一-鿿]/);
    expect(RECENT_DIALOGUE_HEADER_EN).not.toMatch(/[一-鿿]/);
  });

  it("serializeUserHistory(en) uses English framing and English fences", () => {
    const text = serializeUserHistory(sampleUserMessages, "en");
    expect(text).toMatch(/--- user request 1 ---/);
    expect(text).toMatch(/--- end user request 1 ---/);
    expect(text).toMatch(/--- user request 2 ---/);
    expect(text).toContain("fix the failing parser test");
    expect(text).toMatch(/most recent user message as the primary task/);
    expect(text).not.toMatch(/[一-鿿]/);
  });

  it("build(lang:en) uses the EN contract, EN headers, and EN user history, in order", () => {
    const builder = new BackendContextBuilder({
      tools: new InMemoryToolRegistry(),
    });
    const frame = builder.build({
      brief: sampleBrief,
      userMessages: sampleUserMessages,
      scopedRepoInstructions: "",
      scopedMemory: "",
      messages: [],
      lang: "en",
      workingHistory: "done · 1 file",
      recentDialogue: "Herta: want caching?\n\nUser: yes",
    });
    const sys = frame.backendSystem;
    expect(sys.startsWith("You are the coding execution backend")).toBe(true);
    const iHist = sys.indexOf(WORKING_HISTORY_HEADER_EN);
    const iDialogue = sys.indexOf(RECENT_DIALOGUE_HEADER_EN);
    const iUser = sys.indexOf("--- user request 1 ---");
    expect(iHist).toBeGreaterThan(0);
    expect(iDialogue).toBeGreaterThan(iHist);
    expect(iUser).toBeGreaterThan(iDialogue);
    // No zh backend prose leaks into an EN frame.
    expect(sys).not.toContain(BACKEND_EXECUTION_CONTRACT);
    expect(sys).not.toContain("开拓者请求");
    expect(sys).not.toContain(WORKING_HISTORY_HEADER);
  });

  it("zh is unchanged: omitting lang equals lang:'zh' (byte-identical)", () => {
    const builder = new BackendContextBuilder({
      tools: new InMemoryToolRegistry(),
    });
    const common = {
      brief: sampleBrief,
      userMessages: sampleUserMessages,
      scopedRepoInstructions: "",
      scopedMemory: "",
      messages: [],
      workingHistory: "完成 · 1 file",
      recentDialogue: "黑塔：要我加缓存吗？\n\n开拓者：好",
    };
    const omitted = builder.build({ ...common });
    const explicitZh = builder.build({ ...common, lang: "zh" });
    expect(explicitZh.backendSystem).toBe(omitted.backendSystem);
    expect(omitted.backendSystem.startsWith("你是后端的编码执行智能体")).toBe(
      true,
    );
  });
});

describe("minimal contract (ADR 0040)", () => {
  const common = {
    brief: sampleBrief,
    userMessages: sampleUserMessages,
    scopedRepoInstructions: "",
    scopedMemory: "",
    messages: [],
  };

  it("defaults to the standard contract", () => {
    const tools = new InMemoryToolRegistry();
    const builder = new BackendContextBuilder({ tools });
    expect(builder.contract).toBe("standard");
    expect(builder.build(common).backendSystem).toContain(
      BACKEND_EXECUTION_CONTRACT,
    );
  });

  it("emits the short 板砖 prompt instead of the standard contract, keeps the history sections", () => {
    const tools = new InMemoryToolRegistry();
    const builder = new BackendContextBuilder({
      tools,
      contract: "minimal",
      workspaceHint: () => "E:\\repo（bash 里写作 /e/repo）",
    });
    const sys = builder.build({
      ...common,
      workingHistory: "### 派活 1",
    }).backendSystem;
    expect(sys).not.toContain(BACKEND_EXECUTION_CONTRACT);
    expect(sys).not.toContain("# 任务分类");
    expect(sys.startsWith("你是板砖，黑塔的差分协处理器")).toBe(true);
    // The owner's asks: name, who calls it and how, what it produces, where.
    expect(sys).toContain("@板砖");
    expect(sys).toContain("开拓者");
    expect(sys).toContain("report_finding");
    expect(sys).toContain("show_excerpt");
    expect(sys).toContain("不扮演黑塔");
    expect(sys).toContain("工作区：E:\\repo（bash 里写作 /e/repo）。");
    expect(sys).toContain(WORKING_HISTORY_HEADER);
    expect(sys).toContain(serializeUserHistory(sampleUserMessages));
    // Short by design: well under a fifth of the standard contract.
    expect(minimalBackendContract("zh").length).toBeLessThan(
      BACKEND_EXECUTION_CONTRACT.length / 5,
    );
  });

  it("omits the workspace line when the hint is absent, and re-reads the getter per build", () => {
    const tools = new InMemoryToolRegistry();
    let ws: string | undefined;
    const builder = new BackendContextBuilder({
      tools,
      contract: "minimal",
      workspaceHint: () => ws,
    });
    expect(builder.build(common).backendSystem).not.toContain("工作区：");
    ws = "/home/u/proj";
    expect(builder.build(common).backendSystem).toContain(
      "工作区：/home/u/proj。",
    );
  });

  it("EN sessions get the English 板砖 prompt with the @Brick alias", () => {
    const tools = new InMemoryToolRegistry();
    const builder = new BackendContextBuilder({ tools, contract: "minimal" });
    const sys = builder.build({ ...common, lang: "en" }).backendSystem;
    expect(
      sys.startsWith("You are Brick (板砖), Herta's differential coprocessor"),
    ).toBe(true);
    expect(sys).toContain("@Brick");
    expect(sys).toContain("report_finding");
    expect(sys).not.toContain(BACKEND_EXECUTION_CONTRACT_EN);
    expect(sys).not.toMatch(/# Scope classification/);
  });
});

describe("user-facing text follows the conversation's language (ADR 0016 amendment, 2026-09-03)", () => {
  // The findings are shown to the user inside the conversation. A zh session
  // once got an English task list: nothing in the contract said which
  // language the items were in, and the model copied the register of the
  // (English) tool descriptions. Both contracts now say it, in both
  // languages, next to the tool they govern.
  it("zh contracts say the claim is written in Chinese", () => {
    expect(BACKEND_EXECUTION_CONTRACT).toContain("claim 是一句话，用中文写");
    expect(minimalBackendContract("zh")).toContain("claim 用中文写");
  });

  it("EN contracts say the same in English", () => {
    expect(BACKEND_EXECUTION_CONTRACT_EN).toContain(
      '"claim" one sentence written in English',
    );
    expect(minimalBackendContract("en")).toContain("claim in English");
  });

  it("no contract mentions a todo list (ADR 0073)", () => {
    for (const text of [
      BACKEND_EXECUTION_CONTRACT,
      BACKEND_EXECUTION_CONTRACT_EN,
      minimalBackendContract("zh", "/ws"),
      minimalBackendContract("en", "/ws"),
    ]) {
      expect(text).not.toMatch(/todo_write|任务清单|todo list/i);
    }
  });
});

describe("host note (ADR 0044)", () => {
  const common = {
    brief: sampleBrief,
    userMessages: sampleUserMessages,
    scopedRepoInstructions: "",
    scopedMemory: "",
    messages: [],
  };

  it("windowsBackendHostNote names the host and where the Unix habits go, both languages", () => {
    const zh = windowsBackendHostNote("zh");
    expect(zh).toContain("# 主机环境");
    expect(zh).toContain("Windows");
    expect(zh).toContain("没有 bash");
    expect(zh).toContain("search_text");
    expect(zh).toContain("run_command");
    const en = windowsBackendHostNote("en");
    expect(en).toContain("# Host environment");
    expect(en).toContain("Windows");
    expect(en).toContain("search_text");
  });

  it("appends the note to the STANDARD contract as its own section, after the base", () => {
    const tools = new InMemoryToolRegistry();
    const builder = new BackendContextBuilder({
      tools,
      hostNote: windowsBackendHostNote("zh"),
    });
    const sys = builder.build(common).backendSystem;
    expect(sys).toContain(BACKEND_EXECUTION_CONTRACT);
    expect(sys).toContain("# 主机环境");
    expect(sys.indexOf("# 主机环境")).toBeGreaterThan(
      sys.indexOf("# 分寸"), // the base contract's last section comes first
    );
  });

  it("without a hostNote the standard frame is byte-identical to before", () => {
    const tools = new InMemoryToolRegistry();
    const withNote = new BackendContextBuilder({
      tools,
      hostNote: windowsBackendHostNote("zh"),
    });
    const without = new BackendContextBuilder({ tools });
    const empty = new BackendContextBuilder({ tools, hostNote: "" });
    expect(without.build(common).backendSystem).not.toContain("# 主机环境");
    // "" behaves like absent (the wiring's spread-nothing path).
    expect(empty.build(common).backendSystem).toBe(
      without.build(common).backendSystem,
    );
    expect(withNote.build(common).backendSystem).not.toBe(
      without.build(common).backendSystem,
    );
  });

  it("the minimal contract carries a note it is given — WHICH note is the wiring's call (2026-09-23)", () => {
    // The Windows note never reaches minimal (the wiring gives it to the
    // standard contract only); the macOS note does, because the Mac's shell
    // is the BSD userland the note describes.
    const tools = new InMemoryToolRegistry();
    const builder = new BackendContextBuilder({
      tools,
      contract: "minimal",
      hostNote: darwinBackendHostNote("zh"),
    });
    const sys = builder.build(common).backendSystem;
    expect(sys).toContain("# 主机环境");
    expect(sys).toContain("macOS");
    const bare = new BackendContextBuilder({ tools, contract: "minimal" });
    expect(bare.build(common).backendSystem).not.toContain("# 主机环境");
  });

  it("darwinBackendHostNote names the BSD differences that fail GNU habits, both languages", () => {
    for (const note of [
      darwinBackendHostNote("zh"),
      darwinBackendHostNote("en"),
    ]) {
      expect(note).toContain("macOS");
      expect(note).toContain("sed -i ''");
      expect(note).toContain("3.2");
      expect(note).toContain("declare -A");
    }
    expect(darwinBackendHostNote("en")).toContain("# Host environment");
    expect(darwinBackendHostNote("zh")).toContain("# 主机环境");
  });
});

describe("repo snapshot section (ADR 0049)", () => {
  const common = {
    brief: sampleBrief,
    userMessages: sampleUserMessages,
    scopedRepoInstructions: "",
    scopedMemory: "",
    messages: [],
  };
  const snapshot: RepoContextSnapshot = {
    root: "E:/repo",
    prefix: "",
    gitDir: "E:/repo/.git",
    branch: "main",
    detached: false,
    headShort: "abc1234",
    upstream: "origin/main",
    ahead: 2,
    behind: 1,
    upstreamGone: false,
    defaultBranch: "main",
    inProgress: null,
    conflicted: [],
    dirty: [
      { x: " ", y: "M", path: "packages/foo.ts" },
      { x: "?", y: "?", path: "scratch.txt" },
    ],
    dirtyTotal: 2,
    recentSubjects: ["abc1234 fix: cursor reset"],
    recentCommits: [
      {
        sha: "abc1234abc1234abc1234abc1234abc1234abc12",
        shortSha: "abc1234",
        subject: "fix: cursor reset",
        unpushed: false,
      },
    ],
  };

  it("renders at most five recent subjects however many the snapshot carries (ADR 0058 §5.4)", () => {
    const many = renderRepoContext(
      {
        ...snapshot,
        recentSubjects: Array.from(
          { length: 8 },
          (_, i) => `sha${i} step ${i}`,
        ),
      },
      "zh",
      "standard",
    );
    expect(many).toContain("  sha4 step 4");
    expect(many).not.toContain("sha5 step 5");
  });

  it("a subfolder workspace is named once and every path is spelled from it (ADR 0058 amendment)", () => {
    const sub = renderRepoContext(
      {
        ...snapshot,
        prefix: "packages/",
        conflicted: ["packages/foo.ts", "README.md"],
        inProgress: "merge",
      },
      "zh",
      "standard",
    );
    expect(sub).toContain(
      "仓库根目录: E:/repo（工作区是其中的 packages/；下列路径相对工作区，../ 开头的在工作区之外）",
    );
    expect(sub).toContain(" M foo.ts");
    expect(sub).toContain("?? ../scratch.txt");
    expect(sub).toContain("冲突文件 2 个: foo.ts、../README.md");
    const en = renderRepoContext(
      { ...snapshot, prefix: "packages/" },
      "en",
      "standard",
    );
    expect(en).toContain("repo root: E:/repo (the workspace is its packages/");
    // At the root: no such line, paths untouched.
    const root = renderRepoContext(snapshot, "zh", "standard");
    expect(root).not.toContain("仓库根目录");
    expect(root).toContain(" M packages/foo.ts");
  });

  it("renders branch, upstream counts, default branch, dirty set and log", () => {
    const zh = renderRepoContext(snapshot, "zh", "standard");
    expect(zh).toContain("# 仓库快照");
    expect(zh).toContain("分支: main → origin/main（领先 2，落后 1）");
    expect(zh).toContain("默认分支: main");
    expect(zh).toContain("未提交改动 2 项:");
    expect(zh).toContain(" M packages/foo.ts");
    expect(zh).toContain("?? scratch.txt");
    expect(zh).toContain("abc1234 fix: cursor reset");
    expect(zh).not.toContain("进行中的操作");
    const en = renderRepoContext(snapshot, "en", "standard");
    expect(en).toContain("# Repo snapshot");
    expect(en).toContain("branch: main → origin/main (ahead 2, behind 1)");
  });

  it("states detached / unborn / no-upstream / clean plainly", () => {
    expect(
      renderRepoContext(
        { ...snapshot, branch: null, detached: true },
        "zh",
        "standard",
      ),
    ).toContain("分支: 游离 HEAD @ abc1234");
    expect(
      renderRepoContext(
        { ...snapshot, headShort: null, upstream: null },
        "zh",
        "standard",
      ),
    ).toContain("分支: main（尚无提交）");
    expect(
      renderRepoContext({ ...snapshot, upstream: null }, "zh", "standard"),
    ).toContain("分支: main（无上游）");
    expect(
      renderRepoContext(
        { ...snapshot, dirty: [], dirtyTotal: 0 },
        "zh",
        "standard",
      ),
    ).toContain("未提交改动: 无");
  });

  it("shows the in-progress operation with its conflict set", () => {
    const mid = renderRepoContext(
      {
        ...snapshot,
        inProgress: "merge",
        conflicted: ["a.ts", "b.ts"],
      },
      "zh",
      "standard",
    );
    expect(mid).toContain("进行中的操作: merge");
    expect(mid).toContain("冲突文件 2 个: a.ts、b.ts");
  });

  it("the honest-truncation line names the tool the CONTRACT mounts", () => {
    const truncated = { ...snapshot, dirtyTotal: 45 };
    expect(renderRepoContext(truncated, "zh", "standard")).toContain(
      "另有 43 项未列出；全量用 git_status 查看",
    );
    expect(renderRepoContext(truncated, "zh", "minimal")).toContain(
      "在 bash 里跑 git status 看全量",
    );
    expect(renderRepoContext(truncated, "en", "minimal")).toContain(
      "run git status in bash for the full set",
    );
  });

  it("build() splices the section right after the contract; absent → byte-identical", () => {
    const tools = new InMemoryToolRegistry();
    const builder = new BackendContextBuilder({ tools });
    const withSnap = builder.build({ ...common, repoContext: snapshot });
    const without = builder.build(common);
    const sys = withSnap.backendSystem;
    expect(sys.indexOf("# 仓库快照")).toBeGreaterThan(
      sys.indexOf("# 分寸"), // after the contract's last section
    );
    expect(sys.indexOf("# 仓库快照")).toBeLessThan(
      sys.indexOf("--- 开拓者请求 1 ---"),
    );
    expect(without.backendSystem).not.toContain("# 仓库快照");
    expect(without.backendSystem).toBe(
      `${BACKEND_EXECUTION_CONTRACT}\n\n${serializeUserHistory(sampleUserMessages)}`,
    );
  });

  it("rides the minimal contract too, in the session's language", () => {
    const tools = new InMemoryToolRegistry();
    const builder = new BackendContextBuilder({ tools, contract: "minimal" });
    const sys = builder.build({
      ...common,
      lang: "en" as const,
      repoContext: snapshot,
    }).backendSystem;
    expect(sys).toContain("# Repo snapshot");
    expect(sys).toContain("branch: main → origin/main (ahead 2, behind 1)");
  });
  it("says the upstream is gone instead of reporting counts against it", () => {
    const gone = { ...snapshot, ahead: 0, behind: 0, upstreamGone: true };
    expect(renderRepoContext(gone, "zh", "standard")).toContain(
      "分支: main → origin/main（上游已不存在，本地提交均未发布）",
    );
    expect(renderRepoContext(gone, "en", "standard")).toContain(
      "branch: main → origin/main (upstream gone; nothing here is published)",
    );
  });
});
