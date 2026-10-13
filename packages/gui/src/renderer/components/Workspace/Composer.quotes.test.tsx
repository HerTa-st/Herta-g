import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  HertaBridgeProvider,
  useHertaBridge,
} from "../../context/HertaBridgeContext.js";
import { renderWithLocale } from "../../i18n/test-util.js";
import { createMockHertaBridge } from "../../ipc/mock-bridge.js";
import type { ComposerQuote } from "../../lib/quote-format.js";
import type { SessionStore } from "../../store/session-store.js";
import { Composer } from "./Composer.js";
import { WorkspaceRefsProvider } from "./WorkspaceRefs.js";

afterEach(() => cleanup());

function StoreProbe(props: { onStore: (s: SessionStore) => void }) {
  props.onStore(useHertaBridge().sessionStore);
  return null;
}

function renderComposer() {
  const mock = createMockHertaBridge();
  let store: SessionStore | null = null;
  renderWithLocale(
    <WorkspaceRefsProvider>
      <HertaBridgeProvider bridge={mock.bridge}>
        <StoreProbe
          onStore={(s) => {
            store = s;
          }}
        />
        <Composer />
      </HertaBridgeProvider>
    </WorkspaceRefsProvider>,
  );
  return {
    mock,
    store: (): SessionStore => {
      if (store === null) throw new Error("store probe never rendered");
      return store;
    },
  };
}

const DIV: ComposerQuote = {
  id: "q1",
  path: "src/calc.js",
  from: 9,
  to: 14,
  text: "export function div(a, b) {\n  return a / b;\n}",
  fence: "js",
};

describe("Composer — quotes from the viewer's page (ADR 0078 §6)", () => {
  it("a staged quote shows as a chip; × takes it back", () => {
    const { store } = renderComposer();
    act(() => store().addComposerQuote(DIV));
    expect(screen.getByText("src/calc.js:9–14")).toBeInTheDocument();
    expect(screen.getByText("export function div(a, b) {")).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", {
        name: "Remove this quote src/calc.js:9–14",
      }),
    );
    expect(screen.queryByText("src/calc.js:9–14")).toBeNull();
    expect(store().getSnapshot().composerQuotes).toEqual([]);
  });

  it("quotes alone are a message: the source goes first, and the chips clear", () => {
    const { mock, store } = renderComposer();
    act(() => store().addComposerQuote(DIV));
    const input = screen.getByPlaceholderText(
      "Ask about this…",
    ) as HTMLTextAreaElement;
    const send = input
      .closest("form")
      ?.querySelector("button[type='submit']") as HTMLButtonElement;
    expect(send.disabled).toBe(false);
    fireEvent.submit(input.closest("form") as HTMLFormElement);
    const sent = mock.calls.submitText[0] ?? "";
    expect(sent).toContain("src/calc.js:9–14");
    expect(sent).toContain("```js\nexport function div(a, b) {");
    expect(store().getSnapshot().composerQuotes).toEqual([]);
  });

  it("typed words follow the quotes", () => {
    const { mock, store } = renderComposer();
    act(() => store().addComposerQuote(DIV));
    const input = screen.getByPlaceholderText(
      "Ask about this…",
    ) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "为什么不判零？" } });
    fireEvent.submit(input.closest("form") as HTMLFormElement);
    const sent = mock.calls.submitText[0] ?? "";
    expect(sent.endsWith("```\n\n为什么不判零？")).toBe(true);
  });
});
