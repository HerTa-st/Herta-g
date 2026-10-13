import { describe, expect, it } from "vitest";
import {
  codePieces,
  markdownBlocks,
  markdownSections,
} from "./piece-segments.js";

describe("codePieces (ADR 0078 §2)", () => {
  it("a run of lines and the blank lines after it is one piece", () => {
    const lines = [
      "export function add(a, b) {",
      "  return a + b;",
      "}",
      "",
      "export function sub(a, b) {",
      "  return a - b;",
      "}",
      "",
      "",
      "export const pi = 3.14;",
    ];
    expect(codePieces(lines)).toEqual([
      { from: 1, to: 4 },
      { from: 5, to: 9 },
      { from: 10, to: 10 },
    ]);
  });

  it("blank lines before the first run belong to it; a file with no blank line is one piece", () => {
    expect(codePieces(["", "", "a", "b"])).toEqual([{ from: 1, to: 4 }]);
    expect(codePieces(["a", "b", "c"])).toEqual([{ from: 1, to: 3 }]);
    expect(codePieces([])).toEqual([]);
  });

  it("a trailing newline's empty line stays with the last piece", () => {
    expect(codePieces("a\n\nb\n".split("\n"))).toEqual([
      { from: 1, to: 2 },
      { from: 3, to: 4 },
    ]);
  });
});

describe("markdownSections (ADR 0078 §2)", () => {
  it("each heading opens a section up to the next; the preamble is its own", () => {
    const src = [
      "Intro line.",
      "",
      "# calc",
      "",
      "One paragraph.",
      "",
      "## 用法",
      "",
      "- add",
      "- sub",
      "",
    ].join("\n");
    expect(markdownSections(src)).toEqual([
      { from: 1, to: 2 },
      { from: 3, to: 6, title: "calc" },
      { from: 7, to: 11, title: "用法" },
    ]);
  });

  it("a heading inside a fence is code, not a section", () => {
    const src = [
      "# one",
      "",
      "```md",
      "# not a heading",
      "```",
      "",
      "# two",
      "x",
    ].join("\n");
    expect(markdownSections(src).map((s) => s.title)).toEqual(["one", "two"]);
  });

  it("a setext heading counts; no heading at all is one section", () => {
    expect(
      markdownSections("Title\n=====\n\ntext\n").map((s) => [s.from, s.title]),
    ).toEqual([[1, "Title"]]);
    expect(markdownSections("just text\nmore\n")).toEqual([{ from: 1, to: 3 }]);
  });
});

describe("markdownBlocks (ADR 0054, amended 2026-10-13)", () => {
  it("each rendered block keeps its source lines; a list keeps its items'", () => {
    const src = [
      "# T",
      "",
      "intro",
      "",
      "- a",
      "- b",
      "  more b",
      "",
      "- c",
      "",
      "```js",
      "x",
      "```",
      "",
      "[r]: http://x",
      "",
      "| a | b |",
      "|---|---|",
      "| 1 | 2 |",
      "",
    ].join("\n");
    expect(markdownBlocks(src)).toEqual([
      { from: 1, to: 1 },
      { from: 3, to: 3 },
      {
        from: 5,
        to: 9,
        items: [
          { from: 5, to: 5 },
          { from: 6, to: 7 },
          { from: 9, to: 9 },
        ],
      },
      { from: 11, to: 13 },
      { from: 17, to: 19 },
    ]);
  });

  it("raw HTML carries its source: the sanitizer decides what it makes", () => {
    const [first, second] = markdownBlocks("<!-- note -->\n\ntext\n");
    expect(first).toMatchObject({ from: 1, to: 1 });
    expect(first?.html).toContain("<!-- note -->");
    expect(second).toEqual({ from: 3, to: 3 });
  });
});
