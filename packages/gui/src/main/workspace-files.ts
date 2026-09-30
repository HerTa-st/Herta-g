import { readdir } from "node:fs/promises";
import { join } from "node:path";

/**
 * The workspace's files for the composer's @-mention list (ADR 0072 §2).
 * User-only display, like the file viewer's read (read-workspace-file.ts):
 * the jail is the session's backend workspace, and a picked path reaches
 * 板砖 as the user's words, where the model's own path-safety applies.
 *
 * Asynchronous and bounded (ADR 0068: nothing long and synchronous on the
 * main thread): breadth-first `readdir`, no symlink followed, stopping at
 * `MAX_LISTED_FILES` files or `MAX_VISITED_ENTRIES` entries. The folders a
 * person would not mention — the repository's and Herta's own, dependencies,
 * build output, caches, credential stores — are not entered.
 */

export const MAX_LISTED_FILES = 5_000;
export const MAX_VISITED_ENTRIES = 30_000;
/** A directory with more entries than this is not sorted (see the walk). */
export const SORTED_DIR_MAX_ENTRIES = 2_000;

const SKIPPED_DIRS = new Set([
  ".git",
  ".herta",
  ".hg",
  ".svn",
  "node_modules",
  "bower_components",
  "vendor",
  "dist",
  "build",
  "out",
  "coverage",
  "target",
  ".next",
  ".nuxt",
  ".turbo",
  ".cache",
  ".parcel-cache",
  ".gradle",
  ".idea",
  ".vs",
  "__pycache__",
  ".venv",
  "venv",
  ".tox",
  ".mypy_cache",
  ".pytest_cache",
  // Credential stores: never offered, whatever the workspace holds.
  ".ssh",
  ".aws",
  ".gnupg",
  ".docker",
  ".kube",
]);

export interface WorkspaceFileList {
  /** Workspace-relative paths with `/`, breadth-first. */
  readonly files: readonly string[];
  /** A cap was reached: the list is not the whole workspace. */
  readonly truncated: boolean;
}

export async function listWorkspaceFiles(
  root: string,
  opts: { readonly maxFiles?: number; readonly maxVisited?: number } = {},
): Promise<WorkspaceFileList> {
  const maxFiles = opts.maxFiles ?? MAX_LISTED_FILES;
  const maxVisited = opts.maxVisited ?? MAX_VISITED_ENTRIES;
  const files: string[] = [];
  const queue: string[] = [""];
  let visited = 0;
  while (queue.length > 0) {
    const rel = queue.shift() as string;
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(rel === "" ? root : join(root, rel), {
        withFileTypes: true,
      });
    } catch {
      continue; // unreadable: skipped, not fatal
    }
    // Alphabetical, so the list under the cap is the same every time — for
    // a directory of ordinary size. One flat folder of two hundred thousand
    // files (screenshots, logs) sorted with the collator stalled the main
    // thread for seconds on every first `@` (review 2026-09-30); such a
    // folder is taken as read, and `rankPaths` orders what is shown anyway.
    if (entries.length <= SORTED_DIR_MAX_ENTRIES) {
      entries.sort((a, b) => a.name.localeCompare(b.name));
    }
    for (const e of entries) {
      visited += 1;
      if (visited > maxVisited) return { files, truncated: true };
      const path = rel === "" ? e.name : `${rel}/${e.name}`;
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        if (!SKIPPED_DIRS.has(e.name)) queue.push(path);
      } else if (e.isFile()) {
        files.push(path);
        if (files.length >= maxFiles) return { files, truncated: true };
      }
    }
  }
  return { files, truncated: false };
}
