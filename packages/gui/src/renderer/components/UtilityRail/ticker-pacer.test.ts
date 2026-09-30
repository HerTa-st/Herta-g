import { describe, expect, it } from "vitest";
import type { LiveToolView } from "../../ipc/bridge-types.js";
import {
  createTicker,
  FLYBY_MS,
  headlineOf,
  STABLE_MS,
  TICKER_AS_SHIPPED,
  TICKER_PACED,
  type Ticker,
  type TickerOptions,
} from "./ticker-pacer.js";

const view = (over: Partial<LiveToolView>): LiveToolView => ({
  id: "c1",
  tool: "str_replace_editor",
  stage: "writing",
  started: false,
  done: false,
  streams: true,
  mode: "text",
  tail: "",
  lines: 0,
  ...over,
});

/** A file's text so far as a view (the tail is its last lines). */
const writing = (text: string, over: Partial<LiveToolView> = {}) =>
  view({ tail: text, lines: text.split("\n").length, ...over });

/** Feed views at the given times, then keep asking at each wakeAt until
 *  `until`; returns every distinct frame text in the order shown. */
function play(
  opts: TickerOptions,
  feed: Array<[number, LiveToolView]>,
  until: number,
): { shown: string[]; last: ReturnType<Ticker["next"]> } {
  const t = createTicker("c1", opts);
  const shown: string[] = [];
  let last = t.next(feed[0]?.[1] ?? view({}), feed[0]?.[0] ?? 0);
  let current = feed[0]?.[1] ?? view({});
  const note = () => {
    const text = last.frame?.text;
    if (text !== undefined && shown.at(-1) !== text) shown.push(text);
  };
  note();
  let i = 1;
  let now = feed[0]?.[0] ?? 0;
  while (now < until) {
    const nextFeed = feed[i]?.[0] ?? Number.POSITIVE_INFINITY;
    const nextWake = last.wakeAt ?? Number.POSITIVE_INFINITY;
    now = Math.min(nextFeed, nextWake, until);
    if (now === nextFeed) {
      current = feed[i]?.[1] ?? current;
      i += 1;
    }
    last = t.next(current, now);
    note();
    if (nextFeed === Number.POSITIVE_INFINITY && last.wakeAt === null) break;
  }
  return { shown, last };
}

const FILE = [
  "// Fibonacci, iteratively.",
  "export function fib(n) {",
  "  let a = 0, b = 1;",
  "  for (let i = 0; i < n; i++) {",
  "    [a, b] = [b, a + b];",
  "  }",
  "  return a;",
  "}",
].join("\n");

describe("the paced ticker (owner 2026-09-30)", () => {
  it("holds each line long enough to read, then jumps to the newest — passing over the lines between", () => {
    const lines = FILE.split("\n");
    // The model writes a line every 40 ms, far faster than a line can be read.
    const feed: Array<[number, LiveToolView]> = lines.map((_, n) => [
      n * 40,
      writing(`${lines.slice(0, n + 1).join("\n")}\n`),
    ]);
    const t = createTicker("c1", TICKER_PACED);
    const shownAt: Array<[number, string]> = [];
    let now = 0;
    let i = 0;
    let step = t.next(feed[0]?.[1] ?? view({}), 0);
    while (now < 2000) {
      const text = step.frame?.text;
      if (text !== undefined && shownAt.at(-1)?.[1] !== text)
        shownAt.push([now, text]);
      const nextFeed = feed[i + 1]?.[0] ?? Number.POSITIVE_INFINITY;
      now = Math.min(
        nextFeed,
        step.wakeAt ?? Number.POSITIVE_INFINITY,
        now + 50,
      );
      if (now === nextFeed) i += 1;
      step = t.next(feed[i]?.[1] ?? view({}), now);
    }
    // No two lines within a hold of each other while writing.
    for (let k = 1; k < shownAt.length; k += 1) {
      const gap = (shownAt[k]?.[0] ?? 0) - (shownAt[k - 1]?.[0] ?? 0);
      expect(gap).toBeGreaterThanOrEqual(TICKER_PACED.dwellMs);
    }
    // Fewer lines shown than written.
    expect(shownAt.length).toBeLessThan(lines.length);
  });

  it("never shows a half-written line: it waits until a newer line begins, or until it holds still", () => {
    const { shown } = play(
      TICKER_PACED,
      [
        [0, writing("const alpha = 1;\nconst be")],
        [100, writing("const alpha = 1;\nconst beta")],
      ],
      150,
    );
    expect(shown).toEqual(["const alpha = 1;"]);
    // Held still past STABLE_MS: it is whole enough to show.
    const later = play(
      TICKER_PACED,
      [[0, writing("const alpha = 1;\nconst beta = 2;")]],
      TICKER_PACED.dwellMs + STABLE_MS,
    );
    expect(later.shown).toEqual(["const alpha = 1;", "const beta = 2;"]);
  });

  it("passes over lines with no words — braces, brackets, a bare comment mark", () => {
    const { shown } = play(
      TICKER_PACED,
      [[0, writing("  return a;\n}\n});\n//\n]")]],
      1000,
    );
    expect(shown).toEqual(["  return a;"]);
  });

  it("a finished step settles on what it did, not on its last `}`", () => {
    const { shown, last } = play(
      TICKER_PACED,
      [[0, writing(FILE, { started: true, done: true, ok: true })]],
      3000,
    );
    expect(last.frame?.text).toBe("export function fib(n) {");
    expect(last.frame?.settled).toBe(true);
    expect(last.wakeAt).toBeNull();
    expect(shown.some((s) => s.trim() === "}")).toBe(false);
  });

  it("an instant write plays two of its lines on the way to its headline — briskly", () => {
    const t = createTicker("c1", TICKER_PACED);
    const done = writing(FILE, { started: true, done: true, ok: true });
    const a = t.next(done, 0);
    expect(a.frame?.settled).toBe(false);
    expect(a.wakeAt).toBe(FLYBY_MS);
    const b = t.next(done, FLYBY_MS);
    expect(b.frame?.text).not.toBe(a.frame?.text);
    const end = t.next(done, FLYBY_MS * 2);
    expect(end.frame?.text).toBe("export function fib(n) {");
    expect(end.frame?.settled).toBe(true);
    // Each line rose in once: three keys.
    expect(new Set([a.frame?.key, b.frame?.key, end.frame?.key]).size).toBe(3);
  });

  it("a step that streamed long enough to be watched has no fly-by: it settles after a brief hold", () => {
    const t = createTicker("c1", TICKER_PACED);
    t.next(writing("export const a = 1;\n"), 0);
    t.next(writing("export const a = 1;\nexport const b = 2;\n"), 400);
    const done = writing("export const a = 1;\nexport const b = 2;\n}", {
      done: true,
      started: true,
    });
    const held = t.next(done, 450);
    expect(held.frame?.settled).toBe(false);
    const end = t.next(done, 400 + FLYBY_MS);
    expect(end.frame?.text).toBe("export const a = 1;");
    expect(end.frame?.settled).toBe(true);
  });

  it("settling on the line already showing does not make it rise in again", () => {
    const t = createTicker("c1", TICKER_PACED);
    const run = { tool: "bash", stage: "running" as const, started: true };
    const a = t.next(view({ ...run, tail: "ok", lines: 1 }), 0);
    const b = t.next(view({ ...run, tail: "ok", lines: 1 }), STABLE_MS);
    expect(b.frame?.text).toBe("ok");
    void a;
    const end = t.next(view({ ...run, tail: "ok", lines: 1, done: true }), 600);
    expect(end.frame?.settled).toBe(true);
    expect(end.frame?.key).toBe(b.frame?.key);
  });

  it("a command's first line of output is a new line, though it has the command line's number (gallery 2026-09-30)", () => {
    const t = createTicker("c1", TICKER_PACED);
    const cmd = t.next(
      view({ tool: "bash", tail: "node fib.js", lines: 1 }),
      0,
    );
    const out = view({
      tool: "bash",
      stage: "running",
      started: true,
      tail: "BigInt: true",
      lines: 1,
    });
    t.next(out, 500);
    const shown = t.next(out, 500 + STABLE_MS);
    expect(shown.frame?.text).toBe("BigInt: true");
    expect(shown.frame?.key).not.toBe(cmd.frame?.key);
    expect(shown.frame?.growing).toBe(false);
  });

  it("a long file settles on its top-most declaration, though its top has scrolled out of the tail by the end (gallery 2026-09-30)", () => {
    const head = "export class Parser {\n  private pos = 0;\n";
    const body = Array.from(
      { length: 50 },
      (_, i) => `  private step${i}(): void {\n    this.pos += ${i};\n  }`,
    ).join("\n");
    const text = `${head}${body}\n}`;
    const all = text.split("\n");
    const tailOf = (lines: string[]) =>
      writing(lines.slice(-40).join("\n"), { lines: lines.length });
    const t = createTicker("c1", TICKER_PACED);
    // Streamed over several snapshots: the class line passes through the tail.
    t.next(tailOf(all.slice(0, 20)), 0);
    t.next(tailOf(all.slice(0, 90)), 100);
    const done = { ...tailOf(all), done: true, started: true };
    let step = t.next(done, 200);
    for (let now = 200; step.wakeAt !== null && now < 5000; ) {
      now = step.wakeAt;
      step = t.next(done, now);
    }
    expect(step.frame?.text).toBe("export class Parser {");
    // From the final tail alone, only a method would be left.
    expect(headlineOf(tailOf(all))?.text).toMatch(/^\s+private step/);
  });

  it("a command being written shows as it grows, marked to show its end", () => {
    const t = createTicker("c1", TICKER_PACED);
    const cmd = (text: string) =>
      view({ tool: "bash", commandLine: undefined, tail: text, lines: 1 });
    const a = t.next(cmd("cd /very/long/workspace && node -e"), 0);
    expect(a.frame?.text).toBe("cd /very/long/workspace && node -e");
    expect(a.frame?.growing).toBe(true);
    const b = t.next(cmd('cd /very/long/workspace && node -e "x"'), 100);
    // The same line growing keeps its key — it flows, it does not rise in.
    expect(b.frame?.key).toBe(a.frame?.key);
    expect(b.frame?.text).toContain('"x"');
  });
});

describe("headlineOf — what a finished step did", () => {
  it("a file: what it declares, else its first line that is not a comment", () => {
    expect(headlineOf(writing(FILE))?.text).toBe("export function fib(n) {");
    // A heading names a document — but in code a `#` line is a comment.
    expect(
      headlineOf(writing("# Title\nsome text", { path: "notes/README.md" }))
        ?.text,
    ).toBe("# Title");
    expect(
      headlineOf(writing("# helper\ndef run():\n    pass", { path: "a.py" }))
        ?.text,
    ).toBe("def run():");
    expect(headlineOf(writing("// note\nprint(1)\n}"))?.text).toBe("print(1)");
  });
  it("an edit: its first added line, else its first removed one", () => {
    expect(
      headlineOf(view({ mode: "diff", tail: "-a = 1\n+a = 2\n+}", lines: 3 }))
        ?.text,
    ).toBe("a = 2");
    expect(
      headlineOf(view({ mode: "diff", tail: "-gone()", lines: 1 }))?.sign,
    ).toBe("-");
  });
  it("a command: its output's last line with words — usually its verdict", () => {
    expect(
      headlineOf(
        view({
          tool: "bash",
          stage: "running",
          tail: "PASS a\nTests 12 passed\n",
          lines: 2,
        }),
      )?.text,
    ).toBe("Tests 12 passed");
  });
  it("nothing with words: no headline", () => {
    expect(headlineOf(writing("}\n)"))).toBeNull();
  });
});

describe("TICKER_AS_SHIPPED", () => {
  it("is the ticker ADR 0073 shipped: the newest non-blank line of every snapshot, however half-written, ending on the last one", () => {
    const t = createTicker("c1", TICKER_AS_SHIPPED);
    expect(t.next(writing("a\nb\n  "), 0).frame?.text).toBe("b");
    expect(t.next(writing("a\nb\nexport const c"), 100).frame?.text).toBe(
      "export const c",
    );
    const end = t.next(writing(FILE, { done: true }), 200);
    expect(end.frame?.text).toBe("}");
    expect(
      createTicker("c2", TICKER_AS_SHIPPED).next(
        view({ mode: "diff", tail: "-x\n+y", lines: 2 }),
        0,
      ).frame,
    ).toMatchObject({ text: "y", sign: "+" });
  });
});
