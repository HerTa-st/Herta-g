/**
 * A path as this workspace's record names it: relative to the workspace
 * when it lies inside, whichever spelling the model used — native
 * (`C:\ws\a.ts`), forward-slash (`C:/ws/a.ts`) or the MSYS shell's
 * (`/c/ws/a.ts`) — and as given otherwise (lab 2026-09-30: a live row read
 * `写入 /c/Users/…/workspaces/<uuid>/fib.js` beside the record's `fib.js`).
 *
 * Display and matching only; nothing resolves a file through it.
 */
export function workspaceRelative(
  path: string,
  workspace: string | null,
): string {
  if (workspace === null || workspace.length === 0 || path.length === 0) {
    return path;
  }
  const norm = (p: string): string =>
    p
      .replace(/\\/g, "/")
      // MSYS: `/c/…` is drive C.
      .replace(/^\/([a-zA-Z])(?=\/|$)/, "$1:")
      .replace(/\/+$/, "");
  const p = norm(path);
  const w = norm(workspace);
  // A drive-lettered root compares without case, as Windows does.
  const fold = /^[a-zA-Z]:/.test(w)
    ? (s: string) => s.toLowerCase()
    : (s: string) => s;
  if (fold(p) === fold(w)) return ".";
  if (fold(p).startsWith(`${fold(w)}/`)) return p.slice(w.length + 1);
  return path;
}

/**
 * A command line without the model's leading `cd <workspace> &&` (or `;`),
 * as the record's `Running` row drops it — the shell already starts there.
 * A `cd` anywhere else stays: it says where the command runs.
 */
export function withoutWorkspaceCd(
  line: string,
  workspace: string | null,
): string {
  const m = /^\s*cd\s+(?:"([^"]+)"|'([^']+)'|(\S+))\s*(?:&&|;)\s*/.exec(line);
  if (m === null) return line;
  const dir = m[1] ?? m[2] ?? m[3] ?? "";
  return workspaceRelative(dir, workspace) === "."
    ? line.slice(m[0].length)
    : line;
}
