import { configure, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The diagram and highlighter passes wait on lazy chunks; under full-suite
// contention the default 1s async timeout has flaked (2026-09-03).
configure({ asyncUtilTimeout: 5000 });

import { LocaleProvider } from "../../../i18n/LocaleProvider.js";
import { MarkdownView } from "./MarkdownView.js";

vi.mock("./mermaid-render.js", () => ({
  renderMermaid: async (code: string) => {
    if (code.includes("broken")) throw new Error("parse error");
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("data-diagram", "yes");
    return svg;
  },
}));

function ui(content: string): JSX.Element {
  return (
    <LocaleProvider locale="en" onLocaleChange={() => {}}>
      <MarkdownView content={content} truncated={false} />
    </LocaleProvider>
  );
}

describe("MarkdownView (ADR 0054 §4/§5)", () => {
  it("renders GFM — headings, a table, a task list — through the sanitizer", async () => {
    const { container } = render(
      ui(
        "# Title\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n- [x] done\n- [ ] todo\n",
      ),
    );
    const doc = container.querySelector(".file-viewer__doc") as HTMLElement;
    expect(doc.querySelector("h1")?.textContent).toBe("Title");
    expect(doc.querySelectorAll("td")).toHaveLength(2);
    expect(doc.querySelectorAll('input[type="checkbox"]')).toHaveLength(0);
    // marked's task-list checkboxes are inputs; the sanitizer forbids form
    // controls, so the items stay as text with their li intact.
    expect(doc.querySelectorAll("li")).toHaveLength(2);
    await waitFor(() => expect(doc.querySelector("h1")).not.toBeNull());
  });

  it("strips scripts and event handlers, and disarms links (href → data-href)", () => {
    // The raw-HTML line is a CommonMark HTML block (no inline parsing), so
    // the Markdown link sits in its own paragraph.
    const { container } = render(
      ui(
        '<script>alert(1)</script><img src="x" onerror="alert(1)"> <a href="javascript:alert(1)">j</a>\n\n[go](https://example.com)\n',
      ),
    );
    const doc = container.querySelector(".file-viewer__doc") as HTMLElement;
    expect(doc.querySelector("script")).toBeNull();
    expect(doc.querySelector("img")?.getAttribute("onerror")).toBeNull();
    const links = doc.querySelectorAll("a");
    expect(links.length).toBeGreaterThan(0);
    for (const a of links) {
      expect(a.getAttribute("href")).toBeNull();
    }
    expect(
      doc.querySelector('a[data-href="https://example.com"]'),
    ).not.toBeNull();
  });

  it("swaps a mermaid fence for the diagram and labels one that fails, keeping its source", async () => {
    const { container } = render(
      ui("```mermaid\ngraph TD; A-->B\n```\n\n```mermaid\nbroken\n```\n"),
    );
    const doc = container.querySelector(".file-viewer__doc") as HTMLElement;
    await waitFor(() =>
      expect(
        doc.querySelector("figure.file-viewer__diagram svg[data-diagram]"),
      ).not.toBeNull(),
    );
    await waitFor(() =>
      expect(doc.querySelector(".file-viewer__diagram-failed")).not.toBeNull(),
    );
    expect(
      doc.querySelector("pre > code.language-mermaid")?.textContent,
    ).toContain("broken");
  });

  it("tokenizes other fences with the highlighter once its chunk lands", async () => {
    const { container } = render(ui("```ts\nconst x: number = 1;\n```\n"));
    const doc = container.querySelector(".file-viewer__doc") as HTMLElement;
    await waitFor(() =>
      expect(
        doc.querySelector("code.language-ts .hljs-keyword"),
      ).not.toBeNull(),
    );
  });
});

describe("MarkdownView — a cite lands on the page (ADR 0054, amended 2026-10-13)", () => {
  // jsdom lays nothing out: each marked element stands at 20px per source
  // line, and everything else at the origin.
  beforeEach(() => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function (this: HTMLElement) {
        const m = /^(\d+)-(\d+)$/.exec(this.dataset.lines ?? "");
        const top = m === null ? 0 : Number(m[1]) * 20;
        const bottom = m === null ? 0 : Number(m[2]) * 20 + 20;
        return {
          top,
          bottom,
          left: 0,
          right: 0,
          width: 0,
          height: bottom - top,
          x: 0,
          y: top,
          toJSON: () => ({}),
        } as DOMRect;
      },
    );
  });
  afterEach(() => vi.restoreAllMocks());

  const PAGE = [
    "# A",
    "",
    "one",
    "",
    "- x",
    "- y",
    "- z",
    "",
    "## B",
    "",
    "two",
    "",
  ].join("\n");

  function anchored(
    content: string,
    anchor?: { from: number; to: number },
  ): { container: HTMLElement; unmapped: ReturnType<typeof vi.fn> } {
    const unmapped = vi.fn();
    const { container } = render(
      <LocaleProvider locale="en" onLocaleChange={() => {}}>
        <MarkdownView
          content={content}
          truncated={false}
          anchor={anchor}
          onAnchorUnmapped={unmapped}
        />
      </LocaleProvider>,
    );
    return { container, unmapped };
  }

  const bandOf = (container: HTMLElement) =>
    container.querySelector(
      ".file-viewer__doc-host > .file-viewer__anchor",
    ) as HTMLElement | null;

  it("a cited list item bands that item, not the whole list", () => {
    const { container, unmapped } = anchored(PAGE, { from: 6, to: 6 });
    const band = bandOf(container);
    expect(band?.style.top).toBe("117px");
    expect(band?.style.height).toBe("26px");
    expect(unmapped).not.toHaveBeenCalled();
  });

  it("a cited range bands every block it touches, top to bottom", () => {
    const { container } = anchored(PAGE, { from: 9, to: 11 });
    const band = bandOf(container);
    expect(band?.style.top).toBe("177px");
    expect(band?.style.height).toBe("66px");
  });

  it("no cite, no band", () => {
    const { container, unmapped } = anchored(PAGE);
    expect(bandOf(container)).toBeNull();
    expect(unmapped).not.toHaveBeenCalled();
  });

  it("a page whose blocks do not match its lines says so, and draws nothing", () => {
    const { container, unmapped } = anchored(
      "<details>\n\n# Hi\n\n</details>\n",
      { from: 3, to: 3 },
    );
    expect(bandOf(container)).toBeNull();
    expect(unmapped).toHaveBeenCalled();
  });
});
