import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/** The renderer's source root, found from either cwd vitest runs in (see
 *  record-left.test.ts for why not `import.meta.url`). */
const ROOT = ((): string => {
  for (const base of [".", "packages/gui"]) {
    const p = resolve(process.cwd(), base, "src/renderer");
    if (existsSync(p)) return p;
  }
  throw new Error("src/renderer not found from cwd");
})();

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...sourceFiles(p));
    else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) {
      out.push(p);
    }
  }
  return out;
}

/** The comment that owns a deliberate scroll, on the line or up to two
 *  above it. */
const WAIVER = "focus-scrolls:";
const CALL = /\.focus(?:\?\.)?\(/g;
const AUTO = /\bautoFocus\b/g;

/** Everything between the call's `(` and its matching `)`. */
function argsOf(text: string, open: number): string {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "(") depth++;
    else if (text[i] === ")" && --depth === 0) return text.slice(open + 1, i);
  }
  return text.slice(open + 1);
}

function waived(lines: readonly string[], line: number): boolean {
  return lines
    .slice(Math.max(0, line - 2), line + 1)
    .some((l) => l.includes(WAIVER));
}

/** `file:line` for every focus that may scroll without saying why. */
function scrollingFocuses(text: string, file: string): string[] {
  const lines = text.split("\n");
  const lineOf = (at: number): number =>
    text.slice(0, at).split("\n").length - 1;
  const bad: string[] = [];
  for (const m of text.matchAll(CALL)) {
    const at = m.index ?? 0;
    const open = at + m[0].length - 1;
    if (argsOf(text, open).includes("preventScroll")) continue;
    const line = lineOf(at);
    if (!waived(lines, line)) bad.push(`${file}:${line + 1}`);
  }
  for (const m of text.matchAll(AUTO)) {
    const line = lineOf(m.index ?? 0);
    // The prose that explains why autoFocus CAN'T be used is not a use.
    if (/^\s*(\/\/|\*)/.test(lines[line] ?? "")) continue;
    if (!waived(lines, line)) bad.push(`${file}:${line + 1}`);
  }
  return bad;
}

/**
 * A focus() scrolls every scrollable ancestor until the element is in view
 * (owner 2026-09-24). Focusing a Git-card row in the rail — parked 777px to
 * the right while the file viewer closed — scrolled the whole app 656px, and
 * the cards "bounced" as it unwound. Nothing in the code looked wrong: the
 * default is the hazard. So every focus in the renderer either passes
 * `preventScroll`, or names the reason it must scroll (Tab traps, arrow-key
 * lists) in a `// focus-scrolls: <reason>` comment on the line or up to two
 * above. `autoFocus` scrolls the same way and takes the same comment.
 */
/** It reads every renderer source file: ~0.25 s alone, past the 5 s default
 *  in a loaded full run (2026-09-28, a 650 s suite). */
const SCAN_BOUND_MS = 30_000;

describe("focus never scrolls the app by accident", () => {
  it(
    "every renderer focus passes preventScroll or says why it scrolls",
    () => {
      const bad = sourceFiles(ROOT).flatMap((p) =>
        scrollingFocuses(
          readFileSync(p, "utf8"),
          relative(ROOT, p).replaceAll("\\", "/"),
        ),
      );
      expect(bad).toEqual([]);
    },
    SCAN_BOUND_MS,
  );

  it("the scan sees the shapes it guards (not vacuous)", () => {
    const sample = [
      "a.focus();", // 1: bare
      "b?.focus?.();", // 2: optional call
      "<input autoFocus />", // 3: autoFocus
      "c.focus({ preventScroll: true });", // fine
      "d.focus({", // multi-line, fine
      "  preventScroll: true,",
      "});",
      "// focus-scrolls: Tab trap.",
      "e.focus();", // waived
      "// the field can't use autoFocus here", // prose, not a use
    ].join("\n");
    expect(scrollingFocuses(sample, "s")).toEqual(["s:1", "s:2", "s:3"]);
  });
});
