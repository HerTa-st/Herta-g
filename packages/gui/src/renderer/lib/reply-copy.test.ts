import { describe, expect, it } from "vitest";
import { replyProse } from "./reply-copy.js";

describe("what copying a reply takes (ADR 0072 §3)", () => {
  it("her prose, paragraphs kept, fenced code left out", () => {
    expect(
      replyProse(
        "改好了。\n\n```ts\nconst x = 1;\n```\n\n全量测试也过了。",
        "zh",
      ),
    ).toBe("改好了。\n\n全量测试也过了。");
  });

  it("an unclosed fence drops the rest; a code-only reply leaves nothing", () => {
    expect(replyProse("看这个：\n```py\nprint(1)", "zh")).toBe("看这个：");
    expect(replyProse("```\nonly code\n```", "zh")).toBe("");
  });

  it("inline code stays; 板砖 reads Brick in an EN session", () => {
    expect(replyProse("Ask @板砖 to run `pnpm test`.", "en")).toBe(
      "Ask @Brick to run `pnpm test`.",
    );
    expect(replyProse("交给 @板砖。", "zh")).toBe("交给 @板砖。");
  });
});
