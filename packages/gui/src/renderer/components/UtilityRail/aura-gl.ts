/**
 * The tide's GL side, shared by AuraVisual's loop and anything else that
 * draws the same wave (the trailer film, a design harness): where the
 * uniforms live, the theme palette, and one frame's upload + draw. The
 * program itself is built by the caller (webgl.ts createProgram) so each
 * keeps its own fallback path.
 */
import type { AuraFrame } from "./aura-engine.js";

export type Rgb = readonly [number, number, number];

/** The theme's side of the tide (CSS --aura-* on the canvas). */
export interface AuraPalette {
  /** The glass tint (--aura-color). */
  readonly color: Rgb;
  /** The sheets' gray (--aura-base): dark sheets on light, light on dark. */
  readonly base: number;
  /** The glass's tint at the first and the last sheet (uPrism). */
  readonly prismA: Rgb;
  readonly prismB: Rgb;
}

export function hexToRgb(hex: string, fallback: Rgb): Rgb {
  const m = hex.trim().match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  if (!m) return fallback;
  return [m[1], m[2], m[3]].map((c) => parseInt(c ?? "0", 16) / 255) as [
    number,
    number,
    number,
  ];
}

/** The light theme's values — mirrors :root's --aura-* tokens in
 *  reference-ux.css, used when a token is missing (jsdom, a stripped sheet). */
export const LIGHT_AURA_PALETTE: AuraPalette = {
  color: hexToRgb("#3c5a62", [0, 0, 0]),
  base: 0.16,
  prismA: hexToRgb("#13806b", [0, 0, 0]),
  prismB: hexToRgb("#2c55c4", [0, 0, 0]),
};

/** Read the palette the theme sets on `el`, token by token over the light
 *  defaults. */
export function readAuraPalette(el: Element): AuraPalette {
  const cs = getComputedStyle(el);
  const color = (name: string, fallback: Rgb): Rgb =>
    hexToRgb(cs.getPropertyValue(name), fallback);
  const base = Number.parseFloat(cs.getPropertyValue("--aura-base"));
  const d = LIGHT_AURA_PALETTE;
  return {
    color: color("--aura-color", d.color),
    base: Number.isFinite(base) ? base : d.base,
    prismA: color("--aura-prism-a", d.prismA),
    prismB: color("--aura-prism-b", d.prismB),
  };
}

export function auraLocations(gl: WebGLRenderingContext, p: WebGLProgram) {
  const u = (name: string) => gl.getUniformLocation(p, name);
  return {
    position: gl.getAttribLocation(p, "aPosition"),
    resolution: u("iResolution"),
    time: u("iTime"),
    speed: u("uSpeed"),
    blur: u("uBlur"),
    scale: u("uScale"),
    shape: u("uShape"),
    frequency: u("uFrequency"),
    amplitude: u("uAmplitude"),
    bloom: u("uBloom"),
    mix: u("uMix"),
    spacing: u("uSpacing"),
    colorShift: u("uColorShift"),
    variance: u("uVariance"),
    smoothing: u("uSmoothing"),
    mode: u("uMode"),
    color: u("uColor"),
    base: u("uBase"),
    settle: u("uSettle"),
    focus: u("uFocus"),
    crest: u("uCrest"),
    prism: u("uPrism"),
    clock: u("uClock"),
    prismA: u("uPrismA"),
    prismB: u("uPrismB"),
  };
}

export type AuraLocations = ReturnType<typeof auraLocations>;

/** Upload one frame and draw the full-screen quad (bound by the caller).
 *  The fixed values are the tide's locked material (glass-wave study,
 *  2026-07-05): shape 3 is the tide; 1 circle and 2 capsule remain in the
 *  shader for quick A/B. */
export function drawAuraFrame(
  gl: WebGLRenderingContext,
  loc: AuraLocations,
  f: AuraFrame,
  size: { readonly width: number; readonly height: number },
  pal: AuraPalette,
): void {
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.uniform2f(loc.resolution, size.width, size.height);
  gl.uniform1f(loc.time, f.phase);
  gl.uniform1f(loc.speed, f.speed);
  gl.uniform1f(loc.blur, 0.24);
  gl.uniform1f(loc.scale, f.scale);
  gl.uniform1f(loc.shape, 3.0);
  gl.uniform1f(loc.frequency, f.frequency);
  gl.uniform1f(loc.amplitude, f.amplitude);
  gl.uniform1f(loc.bloom, 0.0);
  gl.uniform1f(loc.mix, f.brightness);
  gl.uniform1f(loc.spacing, 0.5);
  gl.uniform1f(loc.colorShift, 0.1);
  gl.uniform1f(loc.variance, 0.1);
  gl.uniform1f(loc.smoothing, 1.0);
  gl.uniform1f(loc.mode, 1.0);
  gl.uniform3fv(loc.color, pal.color);
  gl.uniform1f(loc.base, pal.base);
  gl.uniform1f(loc.settle, f.settle);
  gl.uniform1f(loc.focus, f.focus);
  gl.uniform1f(loc.crest, f.crest);
  gl.uniform1f(loc.prism, f.prism);
  gl.uniform1f(loc.clock, f.clock);
  gl.uniform3fv(loc.prismA, pal.prismA);
  gl.uniform3fv(loc.prismB, pal.prismB);
  gl.drawArrays(gl.TRIANGLES, 0, 6);
}
