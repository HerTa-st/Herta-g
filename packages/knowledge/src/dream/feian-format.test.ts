import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SystemBlock, TerminalRecordBlock } from "@herta/core";
import {
  promptAssetsFor,
  serializeBlock,
  systemRowForHerta,
} from "@herta/herta";
import { describe, expect, it } from "vitest";
import { buildEpisodeDigest, DIGEST_MAX_SYSTEM_ROWS } from "./digest.js";
import {
  countFeianFiles,
  extractNarrativeOpening,
  feianFileIndex,
  nextFeianIndex,
  parseFeianHeader,
  pickEvictableSeedFile,
  validateFeian,
} from "./feian-format.js";

// Resolve the TRACKED canonical seed corpus (packages/herta/prompts/
// feian-seeds — the source materializeSeedFeian copies into workspaces) by
// walking up to the repo root, so the fixture is hermetic: it passes in a
// fresh clone and CI, not just on a machine whose live `.herta/narrative`
// happens to be populated.
function findNarrativeRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 12; depth++) {
    const candidate = join(dir, "packages", "herta", "prompts", "feian-seeds");
    if (existsSync(candidate)) return candidate;
    dir = dirname(dir);
  }
  throw new Error(
    "feian-format.test: could not locate packages/herta/prompts/feian-seeds above the test file",
  );
}

const GOOD = [
  "### 废案_07：午后的噪声",
  "",
  "阮·梅难得主动联系我。",
  "",
  "---",
  "",
  "（开拓者 说）",
  "在吗",
  "（/开拓者 说）",
  "",
  "（我 说）",
  "在。说吧。",
  "（/我 说）",
].join("\n");

describe("validateFeian — accepts", () => {
  it("a well-formed numbered 废案", () => {
    expect(validateFeian(GOOD)).toEqual({ ok: true });
  });

  it("the legacy unnumbered header form", () => {
    expect(validateFeian(GOOD.replace("### 废案_07：", "### 废案："))).toEqual({
      ok: true,
    });
  });
});

describe("validateFeian — rejects", () => {
  const expectErr = (text: string, needle: string) => {
    const r = validateFeian(text);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(" ")).toContain(needle);
  };

  it("a non-废案 first line", () =>
    expectErr(GOOD.replace("### 废案_07：午后的噪声", "## wrong"), "header"));
  it("an unbalanced fence", () =>
    expectErr(GOOD.replace("（/我 说）", ""), "unbalanced"));
  it("a missing （我 说）block", () =>
    expectErr(
      GOOD.replace("（我 说）\n在。说吧。\n（/我 说）", ""),
      "（我 说）",
    ));
  it("a missing --- separator", () =>
    expectErr(GOOD.replace("---", ""), "separator"));
  it("a leaked English structural marker", () =>
    expectErr(`${GOOD}\nVerdict: done`, "marker"));
  it("a western digit-run in the TITLE (one-off log)", () =>
    expectErr(GOOD.replace("午后的噪声", "修复 PR 3492"), "title"));
  it("an ISO date in the TITLE", () =>
    expectErr(GOOD.replace("午后的噪声", "2026-06-18 的复盘"), "title"));
  it("a file-extension token in the TITLE", () =>
    expectErr(GOOD.replace("午后的噪声", "改 foo.ts"), "title"));
  it("a zero-width codepoint anywhere", () =>
    expectErr(
      GOOD.replace("在。", `在${String.fromCharCode(0x200b)}。`),
      "codepoint",
    ));
  it("an LRM (0x200e) invisible directional mark in the body", () =>
    expectErr(
      GOOD.replace("在。", `在${String.fromCharCode(0x200e)}。`),
      "codepoint",
    ));
});

describe("validateFeian — what the prefix would drop is never promoted (dream review 2026-09-22, finding 15)", () => {
  it("rejects nested fences — the load gate is one-deep", () => {
    const nested = GOOD.replace(
      "在。说吧。",
      "在。（开拓者 说）你好（/开拓者 说）说吧。",
    );
    const r = validateFeian(nested);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(" ")).toContain("prefix load gate");
  });

  it("rejects an all-CJK page over the gate's token cap", () => {
    // 15 500 Han characters: above the gate's 10 000 estimated tokens (Han
    // ≈ 0.65 tokens a character), and under the retired 16 000-char cap that
    // this validator used to keep beside it.
    const long = GOOD.replace("阮·梅难得主动联系我。", "黑".repeat(15_500));
    const r = validateFeian(long);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(" ")).toContain("prefix load gate");
  });

  it("the gate's token cap is the only ceiling, so an EN-length page validates (ADR 0014 §6, amended 2026-09-23)", () => {
    // ~28k ASCII chars is ~7k estimated tokens, the size of the EN 00
    // anchor. The retired 16 000-char cap rejected it while a zh page of
    // the same token size passed.
    const prose = "the same content runs three times the chars in english. ";
    const long = GOOD.replace("阮·梅难得主动联系我。", prose.repeat(500));
    expect(long.length).toBeGreaterThan(16_000);
    expect(validateFeian(long)).toEqual({ ok: true });
  });
});

describe("validateFeian — the session digest's notation is not record grammar (ADR 0069, lab for §8 and §9)", () => {
  // Every 〔…〕 line comes from `buildEpisodeDigest` itself, so a marker
  // shape the digest learns later is caught here, not by a live lab.
  const marker = (
    body: string,
    state?: "completed" | "failed" | "interrupted" | "blocked" | "partial",
  ): TerminalRecordBlock => ({
    kind: "system",
    label: "差分协处理器",
    body,
    role: "done-marker",
    ...(state !== undefined
      ? {
          markerSummary: {
            kind: "done" as const,
            state,
            fileCount: 0,
            riskCount: 0,
          },
        }
      : {}),
  });
  const digest = buildEpisodeDigest([
    { kind: "user", text: "把 parser 修了" },
    {
      kind: "herta",
      surface: "speech",
      text: "@板砖 修 parser。",
      selfCorrection: "把 lexer 说成了 parser，已更正",
    },
    {
      kind: "system",
      label: "系统",
      body: "↳ edit_file failed: stale_read: file changed since read",
      digest: { kind: "tool-fail", tool: "edit_file", code: "stale_read" },
    },
    {
      kind: "system",
      label: "差分协处理器",
      body: "Writing a.ts ↳ +2 −1",
      digest: { kind: "op", verb: "Writing", arg: "a.ts" },
    },
    ...Array.from(
      { length: DIGEST_MAX_SYSTEM_ROWS },
      (_, i): TerminalRecordBlock => ({
        kind: "system",
        label: "差分协处理器",
        body: `Reading src/f${i}.ts`,
        digest: { kind: "op", verb: "Reading", arg: `src/f${i}.ts` },
      }),
    ),
    marker("中断 · 0 个文件", "interrupted"),
    marker("失败 · 运行异常中止", "failed"),
    marker("部分完成 · 1 个文件", "partial"),
    marker("受阻 · 缺依赖"),
    marker("完成 · 1 个文件", "completed"),
    { kind: "herta", surface: "speech", text: "只修了一半。" },
  ]);
  // One line per shape: the label-and-tag head (the elision line has no
  // colon, so it is its own key).
  const markerLines = [
    ...new Map(
      digest
        .split("\n")
        .filter((l) => l.startsWith("〔"))
        .map((l) => [l.split("：")[0], l]),
    ).values(),
  ];
  const inDialogue = (line: string) =>
    GOOD.replace("（我 说）\n在。说吧。", `${line}\n\n（我 说）\n在。说吧。`);

  it("the fixture carries every marker the digest writes", () => {
    for (const needle of [
      "〔黑塔的自我更正：",
      "〔……此处略去",
      "〔系统（失败）：",
      "〔差分协处理器（已核实）：",
      "〔差分协处理器（中断）：",
      "〔差分协处理器（失败）：",
      "〔差分协处理器（受阻）：",
      "〔差分协处理器（部分完成）：",
    ]) {
      expect(
        markerLines.some((l) => l.startsWith(needle)),
        needle,
      ).toBe(true);
    }
  });

  it.each(
    markerLines.map((l) => [l]),
  )("rejects a page that copies the digest line %s", (line) => {
    const r = validateFeian(inDialogue(line));
    expect(r.ok).toBe(false);
    // The copied line is the page's only fault: nothing else caught it.
    if (!r.ok) {
      expect(r.errors).toHaveLength(1);
      expect(r.errors[0]).toContain("digest marker");
    }
  });

  it("rejects a marker copied into the middle of a narrative line", () => {
    const r = validateFeian(
      GOOD.replace(
        "阮·梅难得主动联系我。",
        "阮·梅难得主动联系我。板砖回了一句〔差分协处理器（已核实）：完成 · 1 个文件〕。",
      ),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(" ")).toContain("digest marker");
  });

  it("rejects a tag the digest never writes — the shape is the leak", () =>
    expect(
      validateFeian(inDialogue("〔差分协处理器（已完成）：Writing a.ts〕")).ok,
    ).toBe(false));

  it("names the line, so the refine step knows what to rewrite", () => {
    const r = validateFeian(inDialogue("〔系统（失败）：↳ edit_file failed〕"));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors[0]).toContain("〔系统（失败）：↳ edit_file failed〕");
      expect(r.errors[0]).toContain("→ 差分协处理器");
    }
  });

  it("still accepts the record's own furniture — → 系统 / → 差分协处理器 rows", () => {
    const withRows = inDialogue(
      [
        "→ 系统",
        "",
        "```text",
        "Writing a.ts ↳ +2 −1",
        "```",
        "",
        "→ 差分协处理器",
        "",
        "```text",
        "中断 · 0 个文件",
        "```",
      ].join("\n"),
    );
    expect(validateFeian(withRows)).toEqual({ ok: true });
  });

  // A seed or a dream retells 板砖's rows in the grammar her prompt reads
  // them in (ADR 0079 §3). Its English labels once read `Changed:` /
  // `Risks:` / `Evidence:` — the report D3 forbids, which LEAK_MARKERS
  // rejects — so no English page could carry a done-marker's detail.
  it("accepts a done-marker in the grammar her prompt reads, in both languages (ADR 0079 §3)", () => {
    const marker: SystemBlock = {
      kind: "system",
      label: "差分协处理器",
      body: "部分完成 · 1 个文件 · +2 −1 · 1 风险",
      role: "done-marker",
      markerSummary: {
        kind: "done",
        state: "partial",
        fileCount: 1,
        lines: { add: 2, del: 1 },
        riskCount: 1,
      },
      evidenceDetail: [
        "↳ 改动文件: a.ts",
        "↳ 风险: ranks 缺 debug",
        "↳ 结论: 少了一项（a.ts:3）",
        "↳ 依据: ran `pnpm test` (exit 1, 1.00s) — log at .herta/logs/a.log",
      ].join("\n"),
    };
    for (const lang of ["zh", "en"] as const) {
      const row = systemRowForHerta(marker, lang);
      if (row === null) throw new Error("fixture");
      const page = inDialogue(serializeBlock(row, { lang }));
      expect(page).toContain(lang === "en" ? "Based on: " : "依据：");
      expect(validateFeian(page), lang).toEqual({ ok: true });
    }
  });

  it("accepts a self-correction told in her own words, the way the prompt asks", () => {
    expect(
      validateFeian(
        GOOD.replace("在。说吧。", "是 lexer，不是 parser——刚才说错了。说吧。"),
      ),
    ).toEqual({ ok: true });
  });
});

describe("validateFeian — exemptions", () => {
  it("allows CJK numerals and the （其N）series suffix in the title", () => {
    expect(
      validateFeian(
        GOOD.replace("午后的噪声", "远程办公的一百种无聊方式（其七）"),
      ).ok,
    ).toBe(true);
  });
  it("allows file paths in the BODY (transcript half)", () => {
    expect(
      validateFeian(GOOD.replace("在。说吧。", "看了 src/foo.ts，没问题。")).ok,
    ).toBe(true);
  });
  it("allows a single-slash word title like 'Unix/Windows 的对比'", () => {
    expect(
      validateFeian(GOOD.replace("午后的噪声", "Unix/Windows 的对比")).ok,
    ).toBe(true);
  });
});

describe("validateFeian — title path rejection", () => {
  const expectErr = (text: string, needle: string) => {
    const r = validateFeian(text);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(" ")).toContain(needle);
  };

  it("rejects a title containing /etc/passwd", () =>
    expectErr(GOOD.replace("午后的噪声", "/etc/passwd 漏洞"), "title"));
  it("rejects a title containing a Windows drive path C:/Users/x", () =>
    expectErr(GOOD.replace("午后的噪声", "C:/Users/x 路径"), "title"));
});

describe("validateFeian — real seed corpus", () => {
  it("accepts all real seed files as fixtures", () => {
    const root = findNarrativeRoot();
    const files = readdirSync(root).filter((f) =>
      /^### 废案_\d{2,}：.+\.txt$/.test(f),
    );
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const text = readFileSync(join(root, f), "utf8");
      expect(validateFeian(text), `seed: ${f}`).toEqual({ ok: true });
    }
  });

  // The compiled bundles are what materializes into a workspace, in both
  // languages. The EN 00 and 02 anchors (27k / 21k chars, 7.6k / 6.5k
  // estimated tokens) failed the retired 16 000-char ceiling; the length
  // cap is the load gate's estimated tokens now (ADR 0014 §6, amended
  // 2026-09-23), so every seed passes the whole validator, the digest-marker
  // check included. A dream page the size of an anchor is promotable in
  // either language.
  it("accepts every compiled seed, zh and en", () => {
    for (const lang of ["zh", "en"] as const) {
      const seeds = promptAssetsFor(lang).feianSeeds;
      expect(Object.keys(seeds).length).toBeGreaterThan(0);
      for (const [name, body] of Object.entries(seeds)) {
        expect(validateFeian(body), `${lang} seed: ${name}`).toEqual({
          ok: true,
        });
      }
    }
  });
});

describe("parseFeianHeader", () => {
  it("parses a numbered header", () =>
    expect(parseFeianHeader("### 废案_07：午后")).toEqual({
      nn: 7,
      title: "午后",
    }));
  it("parses a legacy unnumbered header", () =>
    expect(parseFeianHeader("### 废案：午后")).toEqual({ title: "午后" }));
  it("returns null for a non-header", () =>
    expect(parseFeianHeader("## nope")).toBeNull());
});

describe("extractNarrativeOpening", () => {
  it("extracts the narrative paragraphs between the header and the first ---", () => {
    const text = [
      "### 废案_07：午后的噪声",
      "",
      "阮·梅难得主动联系我。今天天气很好。",
      "",
      "---",
      "",
      "（我 说）",
      "在。说吧。",
      "（/我 说）",
    ].join("\n");
    expect(extractNarrativeOpening(text)).toBe(
      "阮·梅难得主动联系我。今天天气很好。",
    );
  });

  it("caps the opening at maxChars and appends …", () => {
    const long = "A".repeat(400);
    const text = `### 废案_00：标题\n\n${long}\n\n---\n\n（我 说）\nx\n（/我 说）`;
    const result = extractNarrativeOpening(text, 50);
    expect(result).toBe(`${"A".repeat(50)}…`);
    expect(result.length).toBe(51); // 50 chars + ellipsis character
  });

  it("returns empty string when header is immediately followed by ---", () => {
    const text = [
      "### 废案_00：无叙事",
      "",
      "---",
      "",
      "（我 说）",
      "嗯。",
      "（/我 说）",
    ].join("\n");
    expect(extractNarrativeOpening(text)).toBe("");
  });

  it("skips leading blank lines before the header", () => {
    const text =
      "\n\n### 废案_07：标题\n\n开篇叙事。\n\n---\n\n（我 说）\nx\n（/我 说）";
    expect(extractNarrativeOpening(text)).toBe("开篇叙事。");
  });

  it("returns the whole post-header body when there is no --- separator", () => {
    // validateFeian rejects such text upstream; this documents graceful behavior.
    const text = "### 废案_00：标题\n\n只有叙事，没有分隔符。";
    expect(extractNarrativeOpening(text)).toBe("只有叙事，没有分隔符。");
  });
});

describe("nextFeianIndex", () => {
  it("returns max numbered NN + 1", () =>
    expect(
      nextFeianIndex([
        "### 废案_00：a.txt",
        "### 废案_06：b.txt",
        "### 废案：legacy.txt",
        "### 记录_03：c.txt",
      ]),
    ).toBe(7));
  it("returns 0 for an empty corpus", () => expect(nextFeianIndex([])).toBe(0));
});

describe("feianFileIndex", () => {
  it("parses the NN from a numbered filename", () => {
    expect(feianFileIndex("### 废案_06：种子.txt")).toBe(6);
    expect(feianFileIndex("### 废案_12：梦.txt")).toBe(12);
  });
  it("returns null for legacy unnumbered and non-废案 names", () => {
    expect(feianFileIndex("### 废案：legacy.txt")).toBeNull();
    expect(feianFileIndex("### 记录_03：c.txt")).toBeNull();
    expect(feianFileIndex("EnvSet.txt")).toBeNull();
  });
});

describe("countFeianFiles", () => {
  it("counts numbered + legacy 废案 .txt files, ignoring everything else", () => {
    expect(
      countFeianFiles([
        "### 废案_00：a.txt",
        "### 废案_06：b.txt",
        "### 废案：legacy.txt",
        "### 记录_03：c.txt",
        "EnvSet.txt",
        "HertaBio.txt",
        "openings",
      ]),
    ).toBe(3);
  });
});

describe("pickEvictableSeedFile (M-feian-1)", () => {
  const SEEDS = [
    "### 废案_00：锚点.txt",
    "### 废案_01：别人甲.txt",
    "### 废案_02：别人乙.txt",
    "### 废案_03：种子丙.txt",
    "### 废案_04：种子丁.txt",
    "### 废案_05：种子戊.txt",
    "### 废案_06：种子己.txt",
    "### 废案_07：梦一.txt",
  ];
  const noDreams = new Set<string>();

  it("picks the highest-NN seed in the evictable band first (06 → 03)", () => {
    expect(pickEvictableSeedFile(SEEDS, noDreams, 2, 6)).toBe(
      "### 废案_06：种子己.txt",
    );
    const without06 = SEEDS.filter((f) => !f.startsWith("### 废案_06"));
    expect(pickEvictableSeedFile(without06, noDreams, 2, 6)).toBe(
      "### 废案_05：种子戊.txt",
    );
  });

  it("never returns protected anchors (≤ protectedMaxNN), files above the band, or legacy names", () => {
    const onlyProtected = [
      "### 废案_00：锚点.txt",
      "### 废案_01：别人甲.txt",
      "### 废案_02：别人乙.txt",
      "### 废案：legacy.txt",
      "### 废案_30：手写新篇.txt", // hand-authored above the band — D7 stance holds
    ];
    expect(
      pickEvictableSeedFile(onlyProtected, noDreams, 2, 6),
    ).toBeUndefined();
  });

  it("skips a live dream record even when its NN reuses a band number", () => {
    // After 06 is evicted, nextFeianIndex can hand NN 06 to a NEW dream —
    // the manifest guard must keep it out of seed eviction.
    const files = ["### 废案_03：种子丙.txt", "### 废案_06：梦二.txt"];
    const live = new Set(["### 废案_06：梦二.txt"]);
    expect(pickEvictableSeedFile(files, live, 2, 6)).toBe(
      "### 废案_03：种子丙.txt",
    );
  });
});
