import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import type {
  TerminalRecord,
  TerminalRecordBlock,
} from "../types/terminal-record.js";

/** Session metadata as read from the header line (sans the `_kind` discriminator). */
export interface SessionMeta {
  version: 1;
  sessionId: string;
  startedAt: string;
  workspaceRoot: string;
  backendWorkspace?: string;
  /** Interaction language the session was created under; absent on legacy
   *  headers (written before per-session language persistence). */
  lang?: "zh" | "en";
}

export type SessionFileErrorCode =
  | "not-found"
  | "bad-header"
  | "unknown-version"
  | "corrupt-line";

/**
 * Structured error thrown by `readSessionFile`. `code` discriminates the
 * failure mode; `line` is the 1-based line number for `corrupt-line` errors.
 */
export class SessionFileError extends Error {
  readonly code: SessionFileErrorCode;
  readonly line?: number;

  constructor(opts: {
    code: SessionFileErrorCode;
    message: string;
    line?: number;
  }) {
    super(opts.message);
    this.name = "SessionFileError";
    this.code = opts.code;
    if (opts.line !== undefined) this.line = opts.line;
  }
}

interface RawHeader {
  _kind?: unknown;
  version?: unknown;
  sessionId?: unknown;
  startedAt?: unknown;
  workspaceRoot?: unknown;
  backendWorkspace?: unknown;
  lang?: unknown;
}

/**
 * Read and parse a v0.2 session JSONL file.
 *
 * Behavior:
 *   - Validates `version === 1`. Unknown versions throw
 *     `SessionFileError({ code: "unknown-version" })`.
 *   - Missing / non-`session_meta` / non-JSON header throws
 *     `SessionFileError({ code: "bad-header" })`.
 *   - A truncated final line (interrupted write) is dropped with
 *     `console.warn`; the rest of the file loads cleanly.
 *   - Mid-file invalid JSON throws
 *     `SessionFileError({ code: "corrupt-line", line: N })`.
 *
 * SPEC v0.2 Slice 7b §4.
 */
/** How the last turn ended, when the file recorded it (audit 2026-07-24,
 *  1.6). `atBlockCount` is the record length at the time it was written, so a
 *  later truncation (rewind) can be detected: an entry whose count exceeds
 *  the surviving record describes a turn that no longer exists. */
export interface LastTurnEnd {
  readonly outcome: "completed" | "interrupted" | "failed";
  readonly atBlockCount: number;
}

export interface SessionFileContents {
  meta: SessionMeta;
  record: TerminalRecord;
  latestWorkspaceSet?: string;
  lastTurnEnd?: LastTurnEnd;
}

export function readSessionFile(path: string): SessionFileContents {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    throw notFoundOr(err, path);
  }
  return parseSessionText(raw, path);
}

/**
 * `readSessionFile` off the event loop, for a reader on the desktop app's
 * main thread that is not opening the session — an export (ADR 0072 §3).
 * ADR 0068: no long synchronous fs on main, and a transcript can be tens of
 * megabytes.
 */
export async function readSessionFileAsync(
  path: string,
): Promise<SessionFileContents> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    throw notFoundOr(err, path);
  }
  return parseSessionText(raw, path);
}

function notFoundOr(err: unknown, path: string): unknown {
  const code = (err as { code?: string }).code;
  return code === "ENOENT"
    ? new SessionFileError({
        code: "not-found",
        message: `session file not found: ${path}`,
      })
    : err;
}

function parseSessionText(raw: string, path: string): SessionFileContents {
  const lines = raw.split("\n");
  // biome-ignore lint/style/noNonNullAssertion: guarded by lines.length === 0 check below
  if (lines.length === 0 || lines[0]!.length === 0) {
    throw new SessionFileError({
      code: "bad-header",
      message: `session file is empty: ${path}`,
    });
  }

  // Parse header (line 1).
  let parsedHeader: RawHeader;
  try {
    // biome-ignore lint/style/noNonNullAssertion: guarded by lines.length === 0 check above
    parsedHeader = JSON.parse(lines[0]!) as RawHeader;
  } catch {
    throw new SessionFileError({
      code: "bad-header",
      message: `session file header is not valid JSON: ${path}`,
    });
  }
  if (parsedHeader._kind !== "session_meta") {
    throw new SessionFileError({
      code: "bad-header",
      message: `session file header missing _kind="session_meta": ${path}`,
    });
  }
  if (parsedHeader.version !== 1) {
    throw new SessionFileError({
      code: "unknown-version",
      message: `session was written by a newer version of herta (version=${String(parsedHeader.version)}); cannot load: ${path}`,
    });
  }
  if (
    typeof parsedHeader.sessionId !== "string" ||
    typeof parsedHeader.startedAt !== "string" ||
    typeof parsedHeader.workspaceRoot !== "string"
  ) {
    throw new SessionFileError({
      code: "bad-header",
      message: `session file header missing required fields: ${path}`,
    });
  }
  const meta: SessionMeta = {
    version: 1,
    sessionId: parsedHeader.sessionId,
    startedAt: parsedHeader.startedAt,
    workspaceRoot: parsedHeader.workspaceRoot,
    ...(typeof parsedHeader.backendWorkspace === "string"
      ? { backendWorkspace: parsedHeader.backendWorkspace }
      : {}),
    ...(parsedHeader.lang === "zh" || parsedHeader.lang === "en"
      ? { lang: parsedHeader.lang }
      : {}),
  };

  // Parse blocks (lines 2+). Handle truncated last line.
  const record: TerminalRecordBlock[] = [];
  let latestWorkspaceSet: string | undefined;
  let lastTurnEnd: LastTurnEnd | undefined;
  const trailingEmpty = lines.length > 0 && lines[lines.length - 1] === "";
  // If the file ends in "\n", split yields a trailing empty element; drop it.
  // Otherwise the last element is a real (possibly truncated) line — try to
  // parse it; if it fails, drop with a warn.
  const lastIdx = trailingEmpty ? lines.length - 2 : lines.length - 1;

  for (let i = 1; i <= lastIdx; i++) {
    // biome-ignore lint/style/noNonNullAssertion: i is bounded by lastIdx < lines.length
    const line = lines[i]!;
    if (line === "") continue; // tolerate blank lines mid-file (harmless)
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      if (parsed._kind === "workspace_set") {
        const p = parsed.path;
        if (typeof p === "string") latestWorkspaceSet = p;
        continue; // meta line, not a record block
      }
      if (parsed._kind === "turn_end") {
        // How the LAST turn ended (audit 2026-07-24, 1.6). Tracked with its
        // block position so a later rewind/truncation can invalidate it: an
        // outcome that sits at or above the surviving block count describes a
        // turn that no longer exists.
        const o = parsed.outcome;
        lastTurnEnd =
          o === "completed" || o === "interrupted" || o === "failed"
            ? { outcome: o, atBlockCount: record.length }
            : lastTurnEnd;
        continue; // meta line, not a record block
      }
      if (typeof parsed._kind === "string") continue; // unknown meta — skip
      const block = normalizeBlock(parsed as unknown as TerminalRecordBlock);
      record.push(block);
    } catch {
      if (i === lastIdx && !trailingEmpty) {
        // Last line of a file without trailing newline — interrupted write.
        console.warn(
          `readSessionFile: truncated last line in ${path}, dropped`,
        );
        continue;
      }
      throw new SessionFileError({
        code: "corrupt-line",
        message: `invalid JSON on line ${i + 1}: ${path}`,
        line: i + 1,
      });
    }
  }

  return {
    meta,
    record,
    ...(latestWorkspaceSet !== undefined ? { latestWorkspaceSet } : {}),
    // Drop an outcome the record has since outgrown or been truncated below
    // (a rewind after the turn ended): it no longer describes the tail.
    // STRICT equality — `<=` here silently killed resume-recovery for every
    // session past its first turn: a later crash appends the new turn's user
    // block AFTER the previous turn's `turn_end`, so the stale marker
    // (atBlockCount < record.length) still counted as "the last turn ended
    // deliberately" and the genuinely-lost reply was never regenerated.
    ...(lastTurnEnd !== undefined && lastTurnEnd.atBlockCount === record.length
      ? { lastTurnEnd }
      : {}),
  };
}

/**
 * Backward-compat normalization for blocks loaded from old session files.
 * Pre-Slice-10 herta blocks lacked the `surface` discriminator; default to
 * "speech" so resumed sessions render the same as they did when written.
 */
function normalizeBlock(raw: TerminalRecordBlock): TerminalRecordBlock {
  if (
    raw.kind === "herta" &&
    (raw as { surface?: unknown }).surface === undefined
  ) {
    return {
      kind: "herta",
      surface: "speech",
      text: raw.text,
      // Preserve a per-block timestamp if the on-disk line carried one (the
      // reconstruction would otherwise drop it). Old surface-less blocks
      // predate timestamps, so this is a no-op for them.
      ...(typeof raw.at === "string" ? { at: raw.at } : {}),
    };
  }
  return raw;
}
