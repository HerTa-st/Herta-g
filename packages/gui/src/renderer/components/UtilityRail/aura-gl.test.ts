import { afterEach, describe, expect, it } from "vitest";
import { createAuraAnimator } from "./aura-engine.js";
import {
  auraLocations,
  drawAuraFrame,
  LIGHT_AURA_PALETTE,
  readAuraPalette,
} from "./aura-gl.js";
import { AURA_SHADER_SOURCE } from "./auraShader.js";

afterEach(() => {
  document.documentElement.removeAttribute("style");
});

/** A WebGL stand-in that names each uniform location and records uploads. */
function recordingGl() {
  const asked: string[] = [];
  const uploads = new Map<string, unknown[]>();
  const gl = {
    COLOR_BUFFER_BIT: 0x4000,
    TRIANGLES: 4,
    getUniformLocation: (_p: unknown, name: string) => {
      asked.push(name);
      return { name };
    },
    getAttribLocation: () => 0,
    clearColor: () => {},
    clear: () => {},
    drawArrays: () => {},
  } as Record<string, unknown>;
  for (const m of ["uniform1f", "uniform2f", "uniform3fv"]) {
    gl[m] = (loc: { name: string } | null, ...v: unknown[]) => {
      if (loc === null) throw new Error(`${m} on a missing location`);
      uploads.set(loc.name, v);
    };
  }
  return { gl: gl as unknown as WebGLRenderingContext, asked, uploads };
}

const declared = [...AURA_SHADER_SOURCE.matchAll(/uniform \w+ (\w+);/g)].map(
  (m) => m[1],
);

describe("the tide's GL contract", () => {
  it("asks for exactly the uniforms the shader declares", () => {
    const { gl, asked } = recordingGl();
    auraLocations(gl, {} as WebGLProgram);
    expect(new Set(asked)).toEqual(new Set(declared));
  });

  it("one frame uploads every uniform the shader declares", () => {
    const { gl, uploads } = recordingGl();
    const loc = auraLocations(gl, {} as WebGLProgram);
    const anim = createAuraAnimator("speaking", 0.6);
    anim.step(1 / 60, "speaking", 0.6);
    drawAuraFrame(
      gl,
      loc,
      anim.frame,
      { width: 1600, height: 120 },
      LIGHT_AURA_PALETTE,
    );
    expect(new Set(uploads.keys())).toEqual(new Set(declared));
    expect(uploads.get("iResolution")).toEqual([1600, 120]);
    // The locked material: the tide shape, its fixed blur and spacing.
    expect(uploads.get("uShape")).toEqual([3]);
    expect(uploads.get("uBlur")).toEqual([0.24]);
    // Classic options draw no polish at all.
    for (const u of ["uSettle", "uFocus", "uCrest", "uPrism"]) {
      expect(uploads.get(u)).toEqual([0]);
    }
  });

  it("the shader's early-out covers only the tide shape and grows with the settle", () => {
    // The bound is measured (auraShader.ts); what a test can hold is that it
    // is guarded by the tide branch and widens for the settle's softer sheets.
    expect(AURA_SHADER_SOURCE).toMatch(
      /if \(uShape > 2\.5 && p\.y > -0\.41 \+ 0\.25 \* uAmplitude \+ 0\.2 \* uSettle\)/,
    );
  });
});

describe("readAuraPalette", () => {
  it("falls back to the light palette when the theme sets nothing", () => {
    expect(readAuraPalette(document.documentElement)).toEqual(
      LIGHT_AURA_PALETTE,
    );
  });

  it("takes the theme's tokens", () => {
    const root = document.documentElement;
    root.style.setProperty("--aura-color", "#9fc4ce");
    root.style.setProperty("--aura-base", "0.84");
    root.style.setProperty("--aura-prism-a", "#ffffff");
    const p = readAuraPalette(root);
    expect(p.color).toEqual([0x9f / 255, 0xc4 / 255, 0xce / 255]);
    expect(p.base).toBe(0.84);
    expect(p.prismA).toEqual([1, 1, 1]);
    expect(p.prismB).toEqual(LIGHT_AURA_PALETTE.prismB);
  });

  it("a malformed token keeps that value's default", () => {
    const root = document.documentElement;
    root.style.setProperty("--aura-color", "graphite");
    root.style.setProperty("--aura-base", "dark");
    const p = readAuraPalette(root);
    expect(p.color).toEqual(LIGHT_AURA_PALETTE.color);
    expect(p.base).toBe(LIGHT_AURA_PALETTE.base);
  });
});
