import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { patchTargetPaths, readPatchTargets } from "./patch-targets.js";

describe("patchTargetPaths — the paths a patch writes (review 2026-09-30)", () => {
  it("names every target: git and plain headers, renames, quoted paths; a deletion has none", () => {
    const text = [
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1 +1 @@",
      "-x",
      "+y",
      "diff --git a/old.ts b/new.ts",
      "similarity index 90%",
      "rename from old.ts",
      "rename to new.ts",
      "--- /dev/null",
      "+++ b/.herta/permissions.json\t2026-09-30 00:00:00",
      "--- plain.txt",
      "+++ plain.txt",
      '+++ "b/sp ace.txt"',
      "--- a/gone.ts",
      "+++ /dev/null",
    ].join("\n");
    expect(patchTargetPaths(text)).toEqual([
      "src/a.ts",
      "src/a.ts",
      "new.ts",
      "new.ts",
      ".herta/permissions.json",
      "plain.txt",
      "sp ace.txt",
    ]);
  });

  it("content lines are not headers", () => {
    expect(patchTargetPaths("+ +++ b/x\n++++ b/y\n +++ b/z\n")).toEqual([]);
  });
});

describe("readPatchTargets", () => {
  it("reads a file; a missing path, a directory and one over the cap answer null", async () => {
    const dir = await mkdtemp(join(tmpdir(), "herta-patch-read-"));
    try {
      const file = join(dir, "p.patch");
      await writeFile(file, "--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n");
      expect(readPatchTargets(file)).toEqual(["x"]);
      expect(readPatchTargets(join(dir, "nope.patch"))).toBeNull();
      expect(readPatchTargets(dir)).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
