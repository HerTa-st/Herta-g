import { act, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithLocale } from "../../i18n/test-util.js";
import type { ComposerQuote } from "../../lib/quote-format.js";
import {
  type MaskPiece,
  PIECE_REST_MS,
  quotesFromRuns,
  runsOf,
} from "./PieceQuote.js";
import { CodeView } from "./renderers/CodeView.js";

const piece = (from: number, to: number): MaskPiece => ({
  top: 0,
  height: 0,
  from,
  to,
});

describe("piece quoting — runs and quotes (ADR 0078 §4)", () => {
  it("picked pieces become contiguous runs, in page order", () => {
    expect(runsOf(new Set([4, 0, 1, 2, 6]))).toEqual([[0, 1, 2], [4], [6]]);
    expect(runsOf(new Set())).toEqual([]);
  });

  it("a run quotes its lines as the file has them, trailing blank lines off", () => {
    const lines = ["a", "b", "", "c", "d", ""];
    const [q] = quotesFromRuns(
      [[piece(1, 3), piece(4, 6)]],
      lines,
      "src/x.js",
      "zh",
      "js",
    );
    expect(q).toMatchObject({
      path: "src/x.js",
      from: 1,
      to: 5,
      text: "a\nb\n\nc\nd",
      fence: "js",
    });
  });

  it("each run is its own quote, and a section's title rides along", () => {
    const qs = quotesFromRuns(
      [[{ ...piece(1, 2), title: "用法" }], [piece(5, 5)]],
      ["# 用法", "x", "", "", "y"],
      "README.md",
      "zh",
      "md",
    );
    expect(qs.map((q) => [q.from, q.to, q.title])).toEqual([
      [1, 2, "用法"],
      [5, 5, undefined],
    ]);
  });
});

describe("piece quoting — the mask over the code view (ADR 0078 §3)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const CODE = [
    "export function add(a, b) {",
    "  return a + b;",
    "}",
    "",
    "export function div(a, b) {",
    "  return a / b;",
    "}",
  ].join("\n");

  function render(enabled: boolean) {
    const onQuote = vi.fn<(qs: readonly ComposerQuote[]) => void>();
    const view = renderWithLocale(
      <CodeView
        content={CODE}
        truncated={false}
        piece={{ enabled, path: "src/calc.js", lang: "zh", onQuote }}
      />,
    );
    const host = view.container.querySelector(
      ".file-viewer__code-inner",
    ) as HTMLElement;
    return { ...view, onQuote, host };
  }

  it("a resting pointer lays the mask, cut into the file's pieces", () => {
    const { container, host } = render(true);
    const mask = container.querySelector(".piece-mask") as HTMLElement;
    expect(mask.classList.contains("is-shown")).toBe(false);
    fireEvent.pointerMove(host);
    act(() => vi.advanceTimersByTime(PIECE_REST_MS - 1));
    expect(mask.classList.contains("is-shown")).toBe(false);
    act(() => vi.advanceTimersByTime(1));
    expect(mask.classList.contains("is-shown")).toBe(true);
    expect(container.querySelectorAll(".piece-mask__piece")).toHaveLength(2);
  });

  it("a piece picked and quoted goes out as one quote, and the mask fades", () => {
    const { container, host, onQuote } = render(true);
    fireEvent.pointerMove(host);
    act(() => vi.advanceTimersByTime(PIECE_REST_MS));
    const second = container.querySelectorAll(
      ".piece-mask__piece",
    )[1] as HTMLElement;
    fireEvent.pointerDown(second);
    fireEvent.pointerUp(window);
    expect(second.classList.contains("is-selected")).toBe(true);
    expect(screen.getByText("1 selected")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Quote"));
    expect(onQuote).toHaveBeenCalledTimes(1);
    expect(onQuote.mock.calls[0]?.[0]).toEqual([
      expect.objectContaining({
        path: "src/calc.js",
        from: 5,
        to: 7,
        text: "export function div(a, b) {\n  return a / b;\n}",
      }),
    ]);
    const mask = container.querySelector(".piece-mask") as HTMLElement;
    expect(mask.classList.contains("is-shown")).toBe(false);
  });

  it("leaving the page fades the mask unless something is picked; Escape clears it", () => {
    const { container, host } = render(true);
    const mask = (): HTMLElement =>
      container.querySelector(".piece-mask") as HTMLElement;
    fireEvent.pointerMove(host);
    act(() => vi.advanceTimersByTime(PIECE_REST_MS));
    fireEvent.pointerLeave(host);
    expect(mask().classList.contains("is-shown")).toBe(false);
    fireEvent.pointerMove(host);
    act(() => vi.advanceTimersByTime(PIECE_REST_MS));
    fireEvent.pointerDown(
      container.querySelector(".piece-mask__piece") as Element,
    );
    fireEvent.pointerUp(window);
    fireEvent.pointerLeave(host);
    expect(mask().classList.contains("is-shown")).toBe(true);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(mask().classList.contains("is-shown")).toBe(false);
  });

  it("with the switch off, resting does nothing", () => {
    const { container, host } = render(false);
    fireEvent.pointerMove(host);
    act(() => vi.advanceTimersByTime(PIECE_REST_MS * 2));
    expect(container.querySelector(".piece-mask")).toBeNull();
  });
});
