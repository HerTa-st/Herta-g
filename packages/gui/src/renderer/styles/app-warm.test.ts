import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/** The stylesheet's own bytes, read off disk (see record-left.test.ts for why
 *  not `import.meta.url` or `?raw`); comments stripped, since they name the
 *  very rules checked here. */
const CSS = ((): string => {
  const rel = "src/renderer/styles/reference-ux.css";
  for (const base of [".", "packages/gui"]) {
    const p = resolve(process.cwd(), base, rel);
    if (existsSync(p)) {
      return readFileSync(p, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    }
  }
  throw new Error("reference-ux.css not found from cwd");
})();

/** The `@keyframes app-warm` stops: [percent, opacity]. */
function warmStops(): [number, number][] {
  const block = /@keyframes\s+app-warm\s*\{([\s\S]*?\})\s*\}/.exec(CSS)?.[1];
  if (block === undefined) throw new Error("no @keyframes app-warm");
  const stops: [number, number][] = [];
  for (const m of block.matchAll(
    /([\d%,\s]+)\{\s*opacity\s*:\s*([\d.]+)\s*;?\s*\}/g,
  )) {
    const opacity = Number(m[2]);
    for (const at of (m[1] ?? "").split(",")) {
      const pct = Number.parseFloat(at);
      if (!Number.isNaN(pct)) stops.push([pct, opacity]);
    }
  }
  return stops.sort((a, b) => a[0] - b[0]);
}

/**
 * The hidden workbench is warmed once at mount (ADR 0068 §20): an opacity-0
 * layer is never rastered, so its first raster — and the GPU shader programs
 * it compiles, ~150 ms that Electron never keeps on disk — used to land at
 * the reveal and freeze the opening as it began to dissolve. An opacity
 * blip makes the compositor raster and draw it once, under the splash.
 *
 * jsdom applies no stylesheet, so this reads the source.
 */
describe("the hidden workbench is warmed once, invisibly", () => {
  it(".app.is-booting runs the app-warm animation once", () => {
    const rules = [...CSS.matchAll(/\.app\.is-booting\s*\{([^}]*)\}/g)].map(
      (m) => m[1] ?? "",
    );
    const animation = rules
      .flatMap((r) => [...r.matchAll(/animation\s*:\s*([^;]+);/g)])
      .map((m) => m[1]?.trim());
    expect(animation).toHaveLength(1);
    expect(animation[0]).toMatch(/^app-warm\s+\d+ms\s+\S+\s+1$/);
  });

  it("never shows anything: it starts and ends at 0 and never passes 0.001", () => {
    const stops = warmStops();
    expect(stops[0]).toEqual([0, 0]);
    expect(stops.at(-1)).toEqual([100, 0]);
    for (const [, opacity] of stops) expect(opacity).toBeLessThanOrEqual(0.001);
  });

  it("is a blip, not a ramp: above 0 for at most a tenth of it", () => {
    // Drawn for the whole animation, the app — frosted panels and all — was
    // composited every frame, and the opening's first frame came 0.7 s late.
    // A 0 → 0 animation is dropped as a no-op, so one stop must be above 0.
    const stops = warmStops();
    const lit = stops.filter(([, o]) => o > 0);
    expect(lit.length).toBeGreaterThan(0);
    for (const [at] of lit) {
      const before = stops.filter(([p, o]) => p < at && o === 0).at(-1);
      const after = stops.find(([p, o]) => p > at && o === 0);
      expect(before).toBeDefined();
      expect(after).toBeDefined();
      expect((after?.[0] ?? 100) - (before?.[0] ?? 0)).toBeLessThanOrEqual(10);
    }
  });
});
