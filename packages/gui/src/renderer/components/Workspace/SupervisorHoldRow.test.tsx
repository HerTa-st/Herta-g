import { act } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderWithLocale } from "../../i18n/test-util.js";
import { HINT_ROTATE_MS, SupervisorHoldRow } from "./SupervisorHoldRow.js";

describe("SupervisorHoldRow", () => {
  afterEach(() => vi.useRealTimers());

  it("shimmers the gamma-storm hint, text only (no transfer icons)", () => {
    const { container } = renderWithLocale(<SupervisorHoldRow lang="en" />);
    // Reuses the shimmer shell…
    expect(
      container
        .querySelector(".transfer-text")
        ?.classList.contains("is-shimmer"),
    ).toBe(true);
    expect(container.querySelector(".status-core")).not.toBeNull();
    expect(container.querySelector(".transfer-text")?.textContent).toBe(
      "Message caught in a gamma storm…",
    );
    // …but TEXT ONLY, like the recap row.
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector(".transfer-icon")).toBeNull();
  });

  it("reads in the session's language, not the app's (release review 2026-10-13)", () => {
    const { container } = renderWithLocale(<SupervisorHoldRow lang="zh" />);
    expect(container.querySelector(".transfer-text")?.textContent).toBe(
      "消息受到伽马风暴干扰…",
    );
  });

  it("rotates to the long-wait line after HINT_ROTATE_MS (front-load spec rider)", () => {
    vi.useFakeTimers();
    const { container } = renderWithLocale(<SupervisorHoldRow lang="en" />);
    expect(container.querySelector(".transfer-text")?.textContent).toBe(
      "Message caught in a gamma storm…",
    );
    // On a long judgment the static line itself starts reading as frozen —
    // rotate to the second in-world line. The row unmounts the instant the
    // verdict lands, so the mount timer IS the wait clock.
    act(() => {
      vi.advanceTimersByTime(HINT_ROTATE_MS + 100);
    });
    expect(container.querySelector(".transfer-text")?.textContent).toBe(
      "The storm has not passed — message still en route…",
    );
  });
});
