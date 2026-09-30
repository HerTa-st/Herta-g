import { readFileSync, statSync } from "node:fs";

/** The largest patch the write guard reads. A patch is text the model wrote
 *  a step earlier; one bigger than this is treated as unreadable, which asks. */
export const PATCH_READ_CAP_BYTES = 8 * 1024 * 1024;

/**
 * The paths a unified or git patch WRITES: every `+++` side (git's `b/`
 * prefix stripped, `/dev/null` — a deletion — skipped), the target of a
 * rename or copy header, and the `b/` side of `diff --git`. Pure text: a
 * header inside a heredoc counts the same as one in a file. Used by the
 * `.herta` write guard (review 2026-09-30), so a miss here is a miss there —
 * every header shape git itself emits is covered, quoted paths included.
 */
export function patchTargetPaths(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    let m = /^\+\+\+ (?:"([^"]+)"|([^\t]+))/.exec(line);
    if (m !== null) {
      const p = (m[1] ?? m[2] ?? "").trim();
      if (p.length > 0 && p !== "/dev/null") out.push(stripB(p));
      continue;
    }
    m = /^(?:rename|copy) to (.+)$/.exec(line);
    if (m !== null) {
      out.push(stripB((m[1] as string).trim()));
      continue;
    }
    m =
      /^diff --git (?:"a\/(?:[^"\\]|\\.)*"|a\/\S+) (?:"b\/((?:[^"\\]|\\.)*)"|b\/(\S+))$/.exec(
        line,
      );
    if (m !== null) out.push((m[1] ?? m[2]) as string);
  }
  return out;
}

function stripB(p: string): string {
  return p.startsWith("b/") ? p.slice(2) : p;
}

/** The targets of the patch at `file`, or null when it cannot be read: absent,
 *  a directory, over the cap, or a path that is not a file at all. */
export function readPatchTargets(file: string): readonly string[] | null {
  try {
    const info = statSync(file);
    if (!info.isFile() || info.size > PATCH_READ_CAP_BYTES) return null;
    return patchTargetPaths(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}
