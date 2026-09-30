import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { renderWithLocale } from "../../i18n/test-util.js";
import { GalaxyTravelRow } from "./GalaxyTravelRow.js";
import { HertaBubble } from "./HertaBubble.js";
import { UserBubble } from "./UserBubble.js";

/** A stamped `at` recent enough that the derived label is deterministically
 *  "just now" — relative labels never touch Intl or the machine timezone
 *  (the bubbles take the RAW time since perf 2026-08-25; the label is
 *  derived in their BubbleTime leaf off the shared coarse clock). */
const justNow = (): string => new Date(Date.now() - 5_000).toISOString();

describe("UserBubble", () => {
  it("renders text + timestamp, no avatar", () => {
    renderWithLocale(<UserBubble text="hello" at={justNow()} />);
    expect(screen.getByText("hello")).toBeInTheDocument();
    expect(screen.getByText("just now")).toBeInTheDocument();
    expect(document.querySelector(".message-avatar")).not.toBeInTheDocument();
  });

  it("places the timestamp BELOW the bubble in an action row (hover-reveal), not inside it", () => {
    const { container } = renderWithLocale(
      <UserBubble text="hello" at={justNow()} />,
    );
    const bubble = container.querySelector(".message-bubble");
    const actions = container.querySelector(".message-actions");
    expect(actions).not.toBeNull();
    // The action row is NOT a descendant of the bubble — it sits below it.
    expect(bubble?.contains(actions as Node)).toBe(false);
    // It is the bubble's next sibling, both inside the row, and holds the time.
    expect(bubble?.nextElementSibling).toBe(actions);
    expect(actions?.parentElement?.classList.contains("message-row")).toBe(
      true,
    );
    expect(actions?.querySelector(".message-actions__time")?.textContent).toBe(
      "just now",
    );
  });

  it("hides the action row when no timestamp and no rewind handler", () => {
    renderWithLocale(<UserBubble text="hello" />);
    expect(screen.getByText("hello")).toBeInTheDocument();
    expect(document.querySelector(".message-actions")).toBeNull();
  });

  it("renders a rewind button (calls onRewind) only when onRewind is provided", () => {
    const onRewind = vi.fn();
    const { rerender } = renderWithLocale(
      <UserBubble text="hi" at={justNow()} />,
    );
    // No handler → no rewind button (just the timestamp).
    expect(screen.queryByLabelText("Rewind to here")).toBeNull();
    rerender(<UserBubble text="hi" at={justNow()} onRewind={onRewind} />);
    const btn = screen.getByLabelText("Rewind to here");
    expect(btn.querySelector('svg[data-icon="rewind"]')).not.toBeNull();
    // The button carries a styled tooltip (like the top-bar icons).
    expect(screen.getByRole("tooltip")).toHaveTextContent("Rewind to here");
    btn.click();
    expect(onRewind).toHaveBeenCalledTimes(1);
  });

  it("shows a rewind button even with no timestamp (action row appears for it)", () => {
    renderWithLocale(<UserBubble text="hi" onRewind={() => {}} />);
    expect(screen.getByLabelText("Rewind to here")).toBeInTheDocument();
    expect(document.querySelector(".message-actions")).not.toBeNull();
  });

  it("pictures render ABOVE the bubble with dimension attrs and the caption as alt (ADR 0048 §4)", () => {
    const { container } = renderWithLocale(
      <UserBubble
        text="看看这个"
        images={[
          {
            path: ".herta/attachments/s/a.png",
            name: "a.png",
            caption: "一张三色横条图",
            width: 640,
            height: 480,
          },
          // No caption yet (the optimistic echo): alt falls back to the name.
          { path: ".herta/attachments/s/b.png", name: "b.png" },
        ]}
      />,
    );
    const strip = container.querySelector(".message-images");
    expect(strip).not.toBeNull();
    // Above the bubble: the strip precedes it in the row.
    const bubble = container.querySelector(".message-bubble");
    expect(strip?.nextElementSibling).toBe(bubble);
    const imgs = container.querySelectorAll(".message-images__thumb");
    expect(imgs).toHaveLength(2);
    // Dimensions reserve the box before the bytes load — a morph flight (or
    // a session-open scroll) must not measure a slot that grows under it.
    expect(imgs[0]?.getAttribute("width")).toBe("640");
    expect(imgs[0]?.getAttribute("height")).toBe("480");
    // The caption is what the picture IS; the filename is what it was called.
    expect(imgs[0]?.getAttribute("alt")).toBe("一张三色横条图");
    expect(imgs[1]?.getAttribute("alt")).toBe("b.png");
    expect(imgs[1]?.hasAttribute("width")).toBe(false);
  });
});

describe("HertaBubble", () => {
  it("renders text + timestamp, no avatar", () => {
    renderWithLocale(<HertaBubble text="certainly" at={justNow()} />);
    expect(screen.getByText("certainly")).toBeInTheDocument();
    expect(screen.getByText("just now")).toBeInTheDocument();
    expect(document.querySelector(".message-avatar")).not.toBeInTheDocument();
  });

  it("derives the adaptive label from the stamped time (a 2-min-old block)", () => {
    renderWithLocale(
      <HertaBubble
        text="certainly"
        at={new Date(Date.now() - 2 * 60_000 - 5_000).toISOString()}
      />,
    );
    expect(screen.getByText("2 min ago")).toBeInTheDocument();
  });

  it("scrubs bidi/control characters before they reach the DOM (slice 2)", () => {
    const RLO = String.fromCharCode(0x202e);
    const ESC = String.fromCharCode(0x1b);
    const { container } = renderWithLocale(
      <HertaBubble text={`${RLO}倒着念${ESC}[31m`} at={justNow()} />,
    );
    const textEl = container.querySelector(".message-text");
    expect(textEl?.textContent).toBe("倒着念[31m");
  });

  it("slice 5: multi-paragraph text renders as a bubble stack, timestamp only on the tail", () => {
    const { container } = renderWithLocale(
      <HertaBubble text={"第一段。\n\n第二段。\n\n第三段。"} at={justNow()} />,
    );
    const rows = container.querySelectorAll(".message-row.herta-row");
    expect(rows).toHaveLength(3);
    // Intra-stack rows are tight; the tail row keeps the inter-message gap.
    expect(rows[0]?.classList.contains("is-stack-mid")).toBe(true);
    expect(rows[1]?.classList.contains("is-stack-mid")).toBe(true);
    expect(rows[2]?.classList.contains("is-stack-mid")).toBe(false);
    // One utterance = one action row, under the LAST bubble.
    const actions = container.querySelectorAll(".message-actions");
    expect(actions).toHaveLength(1);
    expect(rows[2]?.contains(actions[0] as Node)).toBe(true);
    expect(screen.getByText("第一段。")).toBeInTheDocument();
    expect(screen.getByText("第三段。")).toBeInTheDocument();
  });

  it("slice 5: a leaked ``` fence renders as a monospace card OUTSIDE the bubble", () => {
    const { container } = renderWithLocale(
      <HertaBubble
        text={"看这段：\n```ts\nconst x = 1;\n```\n就这样。"}
        at={justNow()}
      />,
    );
    const code = container.querySelector(".code-standalone pre.code-block");
    expect(code).not.toBeNull();
    expect(code?.textContent).toBe("const x = 1;");
    // The card header carries the fence's lang tag as a chip.
    expect(
      container.querySelector(".code-card__head .code-card__lang")?.textContent,
    ).toBe("ts");
    // The fence markers themselves never render.
    expect(container.textContent).not.toContain("```");
    // Three rows — prose bubble, bare code card, prose bubble. The code row
    // carries NO bubble chrome (user feedback 2026-07-06: code is not speech).
    const rows = container.querySelectorAll(".message-row.herta-row");
    expect(rows).toHaveLength(3);
    expect(rows[1]?.querySelector(".message-bubble")).toBeNull();
    expect(container.querySelectorAll(".message-bubble")).toHaveLength(2);
  });

  it("slice 5: a lang-less fence falls back to the 'code' chip label", () => {
    const { container } = renderWithLocale(
      <HertaBubble text={"```\nplain()\n```"} at={justNow()} />,
    );
    expect(container.querySelector(".code-card__lang")?.textContent).toBe(
      "code",
    );
  });

  it("inline backtick spans render monospace WITHOUT their delimiters", () => {
    const { container } = renderWithLocale(
      <HertaBubble text={"用 `read_file` 去看。"} at={justNow()} />,
    );
    const inline = container.querySelector("code.inline-code");
    // Slice 5 painted "`read_file`"; the delimiters read as unrendered
    // markup next to any other chat client (owner 2026-07-27). The RECORD
    // still carries them — this is display-only (D7).
    expect(inline?.textContent).toBe("read_file");
    expect(container.textContent).toContain("用 read_file 去看。");
    expect(container.textContent).not.toContain("`");
    // Single paragraph → still exactly one bubble (pre-stack DOM shape).
    expect(container.querySelectorAll(".message-row.herta-row")).toHaveLength(
      1,
    );
  });

  it("slice 5: a single-paragraph reply keeps the pre-stack DOM shape", () => {
    const { container } = renderWithLocale(
      <HertaBubble text="就一句。" at={justNow()} />,
    );
    const rows = container.querySelectorAll(".message-row.herta-row");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.classList.contains("is-stack-mid")).toBe(false);
    expect(
      rows[0]?.querySelector(".message-bubble.herta-bubble .message-text")
        ?.textContent,
    ).toBe("就一句。");
  });

  it("a pre-timestamp block shows no time — its action row carries the copy only", () => {
    renderWithLocale(<HertaBubble text="certainly" />);
    expect(screen.getByText("certainly")).toBeInTheDocument();
    expect(document.querySelector(".message-actions__time")).toBeNull();
    expect(screen.getByLabelText("Copy reply")).toBeInTheDocument();
  });

  it("copies her prose only — the code stays behind (ADR 0072 §3) — and confirms", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    renderWithLocale(
      <HertaBubble
        text={"改好了。\n\n```ts\nconst x = 1;\n```\n\n测试也过了。"}
        at={justNow()}
      />,
    );
    // Once per utterance, on the stack's last row.
    expect(screen.getAllByLabelText("Copy reply")).toHaveLength(1);
    fireEvent.click(screen.getByLabelText("Copy reply"));
    expect(writeText).toHaveBeenCalledWith("改好了。\n\n测试也过了。");
    await waitFor(() =>
      expect(screen.getByLabelText("Copied")).toBeInTheDocument(),
    );
  });

  it("a write the platform refuses is said, not shown as copied (2026-09-30)", async () => {
    const writeText = vi.fn(async () => {
      throw new DOMException("Write permission denied.", "NotAllowedError");
    });
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    renderWithLocale(<HertaBubble text="改好了。" at={justNow()} lang="en" />);
    fireEvent.click(screen.getByLabelText("Copy reply"));
    await waitFor(() =>
      expect(screen.getByLabelText("Copy failed")).toBeInTheDocument(),
    );
    expect(screen.queryByLabelText("Copied")).not.toBeInTheDocument();
  });

  it("the copy button's pill is lifted onto the body, so the scroller's edge cannot cut it (owner 2026-09-29)", () => {
    vi.useFakeTimers();
    try {
      renderWithLocale(<HertaBubble text="certainly" at={justNow()} />);
      const button = screen.getByLabelText("Copy reply");
      // No in-flow pill beside the button: that one was clipped in half at
      // the column's left edge.
      expect(button.parentElement?.querySelector(".tooltip")).toBeNull();
      fireEvent.pointerEnter(button.parentElement as HTMLElement);
      act(() => {
        vi.advanceTimersByTime(500);
      });
      const pill = document.body.querySelector(".tooltip--portal");
      expect(pill?.textContent).toBe("Copy reply");
      expect(pill?.parentElement).toBe(document.body);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a code-only reply offers no copy — its row keeps just the time", () => {
    renderWithLocale(<HertaBubble text={"```\nplain()\n```"} at={justNow()} />);
    expect(screen.queryByLabelText("Copy reply")).toBeNull();
    expect(document.querySelector(".message-actions")).not.toBeNull();
  });

  it("places the timestamp BELOW the bubble in an action row, and never a rewind button", () => {
    const { container } = renderWithLocale(
      <HertaBubble text="certainly" at={justNow()} />,
    );
    const bubble = container.querySelector(".message-bubble");
    const actions = container.querySelector(".message-actions");
    expect(actions).not.toBeNull();
    expect(bubble?.contains(actions as Node)).toBe(false);
    expect(bubble?.nextElementSibling).toBe(actions);
    expect(actions?.parentElement?.classList.contains("message-row")).toBe(
      true,
    );
    // Rewind is a user-turn affordance only.
    expect(screen.queryByLabelText("Rewind to here")).toBeNull();
  });
});

describe("bubbles render @板砖 as a chip", () => {
  it("UserBubble chips a bare mention", () => {
    renderWithLocale(<UserBubble text="重构登录 @板砖" at={justNow()} />);
    const chip = document.querySelector(".banzhuan-mention");
    expect(chip).not.toBeNull();
    expect(chip?.textContent).toBe("@板砖");
  });

  it("UserBubble chips xxx@板砖 (no leading space)", () => {
    renderWithLocale(<UserBubble text="go@板砖" at={justNow()} />);
    expect(document.querySelector(".banzhuan-mention")?.textContent).toBe(
      "@板砖",
    );
  });

  it("HertaBubble chips a bare mention (Herta calling case)", () => {
    renderWithLocale(<HertaBubble text="让 @板砖 去看看" at={justNow()} />);
    expect(document.querySelector(".banzhuan-mention")?.textContent).toBe(
      "@板砖",
    );
  });

  it("a backtick-quoted `@板砖` is NOT chipped", () => {
    renderWithLocale(<HertaBubble text="像 `@板砖` 这样写" at={justNow()} />);
    expect(document.querySelector(".banzhuan-mention")).toBeNull();
  });

  it("plain text with no mention renders unchanged", () => {
    renderWithLocale(<UserBubble text="just text" at={justNow()} />);
    expect(screen.getByText("just text")).toBeInTheDocument();
    expect(document.querySelector(".banzhuan-mention")).toBeNull();
  });
});

describe("GalaxyTravelRow", () => {
  it("renders the Chinese transfer text", () => {
    renderWithLocale(<GalaxyTravelRow />);
    expect(
      screen.getByText("Message is crossing the galaxy…"),
    ).toBeInTheDocument();
  });

  it("plays the entrance (is-shown) after mount", () => {
    vi.stubGlobal("matchMedia", () => ({
      matches: false,
      addEventListener() {},
      removeEventListener() {},
    }));
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      cb(0);
      return 1;
    });
    const { container } = renderWithLocale(<GalaxyTravelRow />);
    const row = container.querySelector(".status-row") as HTMLElement;
    expect(row.classList.contains("is-shown")).toBe(true);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("is shown immediately under reduced motion", () => {
    vi.stubGlobal("matchMedia", () => ({
      matches: true,
      addEventListener() {},
      removeEventListener() {},
    }));
    const { container } = renderWithLocale(<GalaxyTravelRow />);
    expect(
      (
        container.querySelector(".status-row") as HTMLElement
      ).classList.contains("is-shown"),
    ).toBe(true);
    vi.unstubAllGlobals();
  });
});
