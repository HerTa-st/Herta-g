import { describe, expect, it } from "vitest";
import {
  type BaselinedLine,
  encodePicture,
  pictureToken,
  slotPictures,
} from "./pdf-pictures.js";
import { readPng } from "./testing/read-png.js";

/** pdfjs's `ImageKind` values (pdfjs 6). */
const KINDS = { GRAYSCALE_1BPP: 1, RGB_24BPP: 2, RGBA_32BPP: 3 } as const;

const line = (text: string, baseline?: number): BaselinedLine => ({
  text,
  baseline,
});

describe("slotPictures", () => {
  const page = [line("Question 1.", 720), line("(a)", 660), line("(b)", 600)];

  it("puts a picture after the last line at or above its bottom edge", () => {
    expect(slotPictures(page, [{ id: 7, bottom: 610 }])).toEqual([
      "Question 1.",
      "(a)",
      pictureToken(7),
      "(b)",
    ]);
  });

  it("a picture above every line opens the page; one below every line closes it", () => {
    expect(
      slotPictures(page, [
        { id: 1, bottom: 730 },
        { id: 2, bottom: 100 },
      ]),
    ).toEqual([pictureToken(1), "Question 1.", "(a)", "(b)", pictureToken(2)]);
  });

  it("a line with no visible text borrows the baseline before it", () => {
    // The blank line after (a) is not "below" the picture on its own — it has
    // no baseline — so the picture still lands after it, before (b).
    const withBlank = [line("(a)", 660), line(" "), line("(b)", 600)];
    expect(slotPictures(withBlank, [{ id: 3, bottom: 610 }])).toEqual([
      "(a)",
      " ",
      pictureToken(3),
      "(b)",
    ]);
  });

  it("with no pictures the lines come back unchanged", () => {
    expect(slotPictures(page, [])).toEqual(["Question 1.", "(a)", "(b)"]);
  });
});

describe("encodePicture", () => {
  it("RGB pixels become an RGB PNG with the same samples", () => {
    const data = new Uint8Array(8 * 8 * 3).fill(0);
    data.set([255, 0, 0], 0); // top-left pixel red
    const png = readPng(
      encodePicture(
        { width: 8, height: 8, kind: KINDS.RGB_24BPP, data },
        KINDS,
      ) as Buffer,
    );
    expect([png.width, png.height, png.colorType]).toEqual([8, 8, 2]);
    expect([...(png.rows[0]?.subarray(0, 6) ?? [])]).toEqual([
      255, 0, 0, 0, 0, 0,
    ]);
  });

  it("RGBA keeps its alpha", () => {
    const data = new Uint8Array(8 * 8 * 4).fill(128);
    const png = readPng(
      encodePicture(
        { width: 8, height: 8, kind: KINDS.RGBA_32BPP, data },
        KINDS,
      ) as Buffer,
    );
    expect(png.colorType).toBe(6);
    expect(png.rows[0]?.[3]).toBe(128);
  });

  it("1-bit gray expands with pdfjs's convention: a set bit is white", () => {
    // 16 px wide = 2 bytes per row; 0xF0 0x0F = 4 white, 8 black, 4 white.
    const data = new Uint8Array(16).fill(0);
    for (let y = 0; y < 8; y += 1) data.set([0xf0, 0x0f], y * 2);
    const png = readPng(
      encodePicture(
        { width: 16, height: 8, kind: KINDS.GRAYSCALE_1BPP, data },
        KINDS,
      ) as Buffer,
    );
    expect(png.colorType).toBe(0);
    expect([...(png.rows[0] ?? [])]).toEqual([
      255, 255, 255, 255, 0, 0, 0, 0, 0, 0, 0, 0, 255, 255, 255, 255,
    ]);
  });

  it("a picture past 2000 px on its long side is box-downscaled by an integer factor", () => {
    const data = new Uint8Array(2400 * 10 * 3).fill(200);
    const png = readPng(
      encodePicture(
        { width: 2400, height: 10, kind: KINDS.RGB_24BPP, data },
        KINDS,
      ) as Buffer,
    );
    expect([png.width, png.height]).toEqual([1200, 5]);
    expect(png.rows[0]?.[0]).toBe(200);
  });

  it("rejects what it cannot read: specks, bitmaps, unknown layouts, short data", () => {
    const rgb = (w: number, h: number) => new Uint8Array(w * h * 3);
    expect(
      encodePicture(
        { width: 4, height: 4, kind: KINDS.RGB_24BPP, data: rgb(4, 4) },
        KINDS,
      ),
    ).toBeNull();
    expect(
      encodePicture({ width: 8, height: 8, bitmap: {} }, KINDS),
    ).toBeNull();
    expect(
      encodePicture({ width: 8, height: 8, kind: 9, data: rgb(8, 8) }, KINDS),
    ).toBeNull();
    expect(
      encodePicture(
        { width: 8, height: 8, kind: KINDS.RGB_24BPP, data: rgb(8, 7) },
        KINDS,
      ),
    ).toBeNull();
    expect(encodePicture(null, KINDS)).toBeNull();
  });
});
