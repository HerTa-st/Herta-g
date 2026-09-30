import { describe, expect, it } from "vitest";
import {
  readCachedSheet,
  SHEET_CACHE_VERSION,
  sheetCacheKey,
  validCachedSheet,
  writeCachedSheet,
} from "./glyph-sheet-cache.js";

describe("validCachedSheet — a stored record the player can read (review 2026-09-30)", () => {
  const png = new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" });
  const entry = { px: 2, w: 9, h: 13, pos: [0, 0, 9, 0] };

  it("accepts a PNG with one well-formed entry per size", () => {
    expect(validCachedSheet({ png, entries: [entry] }, 2)).toBe(true);
    expect(validCachedSheet({ png, entries: [] }, 2)).toBe(true);
  });

  it("refuses the shapes another build or a corruption could leave", () => {
    for (const bad of [
      undefined,
      null,
      "x",
      { png, entries: undefined },
      { png: "not a blob", entries: [entry] },
      { png, entries: [{ ...entry, pos: undefined }] },
      { png, entries: [{ ...entry, pos: [0, 0] }] }, // one glyph short
      { png, entries: [{ ...entry, pos: [0, 0, 9, Number.NaN] }] },
      { png, entries: [{ ...entry, w: "9" }] },
      { png, entries: [null] },
    ]) {
      expect(validCachedSheet(bad, 2), JSON.stringify(bad)).toBe(false);
    }
  });
});

const REQUEST = {
  sizes: [1.5, 2, 2.5],
  dpr: 1,
  ink: "rgba(60, 60, 67, 1)",
  fontFamily: "Consolas, monospace",
  glyphs: "AB",
};
const ENGINE = "Mozilla/5.0 Chrome/140.0.0.0 Electron/38.0.0";

/** An in-memory IndexedDB with just what the cache uses: open (with the
 *  upgrade on first open), one store, get and put. */
function memoryIdb(): IDBFactory {
  const stores = new Map<string, Map<string, unknown>>();
  let upgraded = false;
  const db = {
    createObjectStore(name: string) {
      stores.set(name, new Map());
    },
    transaction(name: string) {
      const store = stores.get(name) as Map<string, unknown>;
      const tx: { oncomplete?: () => void; objectStore: () => unknown } = {
        objectStore: () => ({
          get(key: string) {
            const request: { result?: unknown; onsuccess?: () => void } = {};
            queueMicrotask(() => {
              request.result = store.get(key);
              request.onsuccess?.();
            });
            return request;
          },
          put(value: unknown, key: string) {
            store.set(key, value);
            queueMicrotask(() => tx.oncomplete?.());
          },
        }),
      };
      return tx;
    },
    close() {},
  };
  return {
    open() {
      const request: {
        result?: unknown;
        onupgradeneeded?: () => void;
        onsuccess?: () => void;
      } = {};
      queueMicrotask(() => {
        request.result = db;
        if (!upgraded) {
          upgraded = true;
          request.onupgradeneeded?.();
        }
        request.onsuccess?.();
      });
      return request;
    },
  } as unknown as IDBFactory;
}

describe("the glyph sheet kept between launches (M-opening-5)", () => {
  it("keys a sheet by everything its pixels depend on", () => {
    const key = sheetCacheKey(REQUEST, ENGINE);
    expect(sheetCacheKey({ ...REQUEST }, ENGINE)).toBe(key);
    expect(key).toContain(String(SHEET_CACHE_VERSION));
    for (const changed of [
      { ...REQUEST, sizes: [1.5, 2] },
      { ...REQUEST, dpr: 1.25 },
      { ...REQUEST, ink: "rgba(208, 218, 228, 1)" },
      { ...REQUEST, fontFamily: "Menlo, monospace" },
      { ...REQUEST, glyphs: "ABC" },
    ]) {
      expect(sheetCacheKey(changed, ENGINE)).not.toBe(key);
    }
    // A new engine (an app update brings one) may draw text differently.
    expect(sheetCacheKey(REQUEST, `${ENGINE} next`)).not.toBe(key);
  });

  it("gives back what was stored under the same key, and nothing for another", async () => {
    const idb = memoryIdb();
    const png = new Blob(["png"], { type: "image/png" });
    const entries = [{ px: 2, w: 6, h: 7, pos: [0, 0, 6, 0] }];
    await writeCachedSheet("k1", { png, entries }, idb);
    await expect(readCachedSheet("k1", idb)).resolves.toEqual({ png, entries });
    await expect(readCachedSheet("k2", idb)).resolves.toBeNull();
  });

  it("keeps one sheet: a new key replaces the old", async () => {
    const idb = memoryIdb();
    const first = new Blob(["a"]);
    const second = new Blob(["b"]);
    await writeCachedSheet("k1", { png: first, entries: [] }, idb);
    await writeCachedSheet("k2", { png: second, entries: [] }, idb);
    await expect(readCachedSheet("k1", idb)).resolves.toBeNull();
    await expect(readCachedSheet("k2", idb)).resolves.toEqual({
      png: second,
      entries: [],
    });
  });

  it("with no storage there is simply no sheet kept (never a throw)", async () => {
    await expect(readCachedSheet("k", undefined)).resolves.toBeNull();
    await expect(
      writeCachedSheet("k", { png: new Blob([]), entries: [] }, undefined),
    ).resolves.toBeUndefined();
    const throwing = {
      open() {
        throw new Error("storage disabled");
      },
    } as unknown as IDBFactory;
    await expect(readCachedSheet("k", throwing)).resolves.toBeNull();
  });
});
