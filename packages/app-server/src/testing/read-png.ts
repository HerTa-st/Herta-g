import { inflateSync } from "node:zlib";

/**
 * Width, height, colour type and the unfiltered pixel rows of a PNG written by
 * `pdf-pictures.ts` (8-bit, one or more IDAT chunks, filter 0 on every row) —
 * enough for a test to check what a picture decoded to. Throws on anything
 * else rather than guessing.
 */
export function readPng(png: Buffer): {
  readonly width: number;
  readonly height: number;
  readonly colorType: number;
  readonly rows: readonly Buffer[];
} {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (!signature.every((b, i) => png[i] === b)) {
    throw new Error("not a PNG");
  }
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  const colorType = png[25] ?? -1;
  const idat: Buffer[] = [];
  for (let at = 8; at < png.length; ) {
    const len = png.readUInt32BE(at);
    if (png.toString("latin1", at + 4, at + 8) === "IDAT") {
      idat.push(png.subarray(at + 8, at + 8 + len));
    }
    at += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 1;
  const rowBytes = width * channels;
  const rows: Buffer[] = [];
  for (let y = 0; y < height; y += 1) {
    const start = y * (rowBytes + 1);
    if (raw[start] !== 0) throw new Error(`row ${y}: filter ${raw[start]}`);
    rows.push(raw.subarray(start + 1, start + 1 + rowBytes));
  }
  return { width, height, colorType, rows };
}
