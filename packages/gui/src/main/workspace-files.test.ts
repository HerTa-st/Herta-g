import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listWorkspaceFiles } from "./workspace-files.js";

let dir = "";
afterEach(() => {
  if (dir !== "") rmSync(dir, { recursive: true, force: true });
  dir = "";
});

function plant(files: readonly string[]): string {
  dir = mkdtempSync(join(tmpdir(), "herta-wsfiles-"));
  for (const f of files) {
    const p = join(dir, f);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, "x");
  }
  return dir;
}

describe("the workspace's files for @-mentions (ADR 0072 §2)", () => {
  it("lists files breadth-first with / separators, skipping the folders a person would not mention", async () => {
    const root = plant([
      "README.md",
      "src/parser.ts",
      "src/lib/tokens.ts",
      ".github/workflows/ci.yml",
      ".git/config",
      ".herta/memory/project.jsonl",
      "node_modules/x/index.js",
      "dist/out.js",
      ".ssh/id_ed25519",
    ]);
    const { files, truncated } = await listWorkspaceFiles(root);
    expect(truncated).toBe(false);
    expect(files).toEqual([
      "README.md",
      "src/parser.ts",
      ".github/workflows/ci.yml",
      "src/lib/tokens.ts",
    ]);
  });

  it("stops at its caps and says so", async () => {
    const root = plant(Array.from({ length: 12 }, (_, i) => `f${i}.txt`));
    expect(await listWorkspaceFiles(root, { maxFiles: 5 })).toEqual({
      files: ["f0.txt", "f1.txt", "f10.txt", "f11.txt", "f2.txt"],
      truncated: true,
    });
    const visited = await listWorkspaceFiles(root, { maxVisited: 3 });
    expect(visited.truncated).toBe(true);
    expect(visited.files).toHaveLength(3);
  });

  it("follows no symlink out of the workspace", async () => {
    const root = plant(["a.txt"]);
    const outside = mkdtempSync(join(tmpdir(), "herta-wsfiles-out-"));
    try {
      writeFileSync(join(outside, "secret.txt"), "x");
      try {
        symlinkSync(outside, join(root, "link"), "junction");
      } catch {
        return; // no permission to link here: nothing to check
      }
      const { files } = await listWorkspaceFiles(root);
      expect(files).toEqual(["a.txt"]);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("an unreadable root lists nothing", async () => {
    expect(
      await listWorkspaceFiles(join(tmpdir(), "herta-no-such-dir-x")),
    ).toEqual({
      files: [],
      truncated: false,
    });
  });
});
