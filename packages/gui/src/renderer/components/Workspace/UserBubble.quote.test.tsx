import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderWithLocale } from "../../i18n/test-util.js";
import { composeQuotedMessage } from "../../lib/quote-format.js";
import { UserBubble } from "./UserBubble.js";

describe("UserBubble — a quote reads as a card (ADR 0078 §7)", () => {
  it("shows the label and the first lines, then what was said", () => {
    const text = composeQuotedMessage(
      [
        {
          id: "q1",
          path: "src/calc.js",
          from: 9,
          to: 14,
          text: "export function div(a, b) {\n  return a / b;\n}\n// four",
          fence: "js",
        },
      ],
      "为什么不判零？",
      "zh",
    );
    const { container } = renderWithLocale(<UserBubble text={text} />);
    expect(screen.getByText("src/calc.js:9–14")).toBeInTheDocument();
    const preview = container.querySelector(".message-quote__text");
    expect(preview?.textContent).toBe(
      "export function div(a, b) {\n  return a / b;\n}",
    );
    expect(screen.getByText("为什么不判零？")).toBeInTheDocument();
    // The raw header and fence never show.
    expect(container.textContent).not.toContain("```");
  });

  it("a message with no quote renders as before", () => {
    const { container } = renderWithLocale(<UserBubble text="hello" />);
    expect(container.querySelector(".message-quote")).toBeNull();
    expect(screen.getByText("hello")).toBeInTheDocument();
  });
});
