import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/** The stylesheet's own bytes, read off disk (see record-left.test.ts for why
 *  not `import.meta.url` or `?raw`). */
const CSS = ((): string => {
  const rel = "src/renderer/styles/reference-ux.css";
  for (const base of [".", "packages/gui"]) {
    const p = resolve(process.cwd(), base, rel);
    if (existsSync(p)) return readFileSync(p, "utf8");
  }
  throw new Error("reference-ux.css not found from cwd");
})();

/** The FIRST `.app{…}` rule — the frame's own box. Comments go first: the
 *  rule's own commentary quotes `body { place-items:center }`, whose brace
 *  would end the match early, and may name the very property checked. */
function appRule(): string {
  const bare = CSS.replace(/\/\*[\s\S]*?\*\//g, "");
  const body = /^\.app\s*\{([^}]*)\}/m.exec(bare)?.[1];
  if (body === undefined) throw new Error("no .app rule");
  return body;
}

/**
 * The app frame must never scroll (owner 2026-09-24). With
 * `overflow: hidden` it was still a scroll container, and focusing a row in
 * the rail — parked 777px right while the file viewer closes — scrolled the
 * whole app 656px left: the sidebar vanished and the cards "bounced" as the
 * scroll unwound. The viewer now focuses with preventScroll; `overflow:
 * clip` makes the frame no scroll container at all, so the next off-screen
 * focus() or scrollIntoView() cannot do it again.
 *
 * jsdom applies no stylesheet, so this reads the source.
 */
describe("the app frame clips, it does not scroll", () => {
  it(".app ends on overflow: clip (after its hidden fallback)", () => {
    const decls = [...appRule().matchAll(/overflow\s*:\s*([a-z-]+)/g)].map(
      (m) => m[1],
    );
    // The last declaration wins where `clip` is known; `hidden` before it is
    // the fallback for an engine that drops the unknown value.
    expect(decls.at(-1)).toBe("clip");
  });
});

/**
 * The frame fills the window at every width. A leftover rule from the
 * caption-button gutter era set `.app { height: calc(100vh - 96px) }` under
 * `max-width: 1200px`; against `position: fixed; inset: 0` it left the frame
 * 96px short, and the body gradient showed as a band along the bottom — in
 * the AppImage catalog's 800x600 screenshot (2026-09-29), and the reason
 * MIN_WINDOW_W was set to 1280. Only the first rule may place the box.
 */
describe("the app frame fills the window", () => {
  it("no later .app rule changes the frame's height or edges", () => {
    const bare = CSS.replace(/\/\*[\s\S]*?\*\//g, "");
    const bodies = [...bare.matchAll(/(?:^|[{},\s])\.app\s*\{([^}]*)\}/g)].map(
      (m) => m[1],
    );
    expect(appRule()).toMatch(/position\s*:\s*fixed/);
    expect(appRule()).toMatch(/inset\s*:\s*0/);
    for (const body of bodies.slice(1)) {
      expect(body).not.toMatch(
        /(?:^|[;\s])(?:(?:min-|max-)?height|top|bottom|inset)\s*:/,
      );
    }
  });
});
