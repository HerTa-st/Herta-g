import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  readSessionFile,
  readSessionFileAsync,
  SessionFileError,
} from "./read-session-file.js";

const HEADER = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    _kind: "session_meta",
    version: 1,
    sessionId: "abc",
    startedAt: "2026-05-15T12:00:00.000Z",
    workspaceRoot: "/p",
    ...overrides,
  });

describe("readSessionFile", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "v2-read-"));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  function write(content: string): string {
    const path = join(tmp, "test.jsonl");
    writeFileSync(path, content, "utf8");
    return path;
  }

  it("parses a header + 3 blocks into { meta, record }", () => {
    const path = write(
      [
        HEADER(),
        '{"kind":"user","text":"hi"}',
        '{"kind":"herta","text":"好"}',
        '{"kind":"system","label":"系统","body":"ok"}',
        "",
      ].join("\n"),
    );
    const { meta, record } = readSessionFile(path);
    expect(meta).toEqual({
      version: 1,
      sessionId: "abc",
      startedAt: "2026-05-15T12:00:00.000Z",
      workspaceRoot: "/p",
    });
    expect(record).toHaveLength(3);
    expect(record[0]).toEqual({ kind: "user", text: "hi" });
    expect(record[1]).toEqual({ kind: "herta", surface: "speech", text: "好" });
    expect(record[2]).toEqual({
      kind: "system",
      label: "系统",
      body: "ok",
    });
  });

  it("preserves a per-block `at` timestamp on read", () => {
    const path = write(
      [
        HEADER(),
        '{"kind":"user","text":"hi","at":"2026-06-18T09:30:00.000Z"}',
        // surfaceless herta block (pre-Slice-10 shape) WITH a timestamp: the
        // surface reconstruction must carry `at` through, not drop it.
        '{"kind":"herta","text":"好","at":"2026-06-18T09:31:00.000Z"}',
        "",
      ].join("\n"),
    );
    const { record } = readSessionFile(path);
    expect(record[0]).toEqual({
      kind: "user",
      text: "hi",
      at: "2026-06-18T09:30:00.000Z",
    });
    expect(record[1]).toEqual({
      kind: "herta",
      surface: "speech",
      text: "好",
      at: "2026-06-18T09:31:00.000Z",
    });
  });

  it("returns empty record when only the header is present", () => {
    const path = write(`${HEADER()}\n`);
    const { record } = readSessionFile(path);
    expect(record).toEqual([]);
  });

  it("throws SessionFileError code=not-found for missing path", () => {
    const path = join(tmp, "does-not-exist.jsonl");
    expect(() => readSessionFile(path)).toThrow(SessionFileError);
    try {
      readSessionFile(path);
    } catch (e) {
      expect((e as SessionFileError).code).toBe("not-found");
    }
  });

  it("throws SessionFileError code=bad-header for missing header line", () => {
    const path = write('{"kind":"user","text":"oops"}\n');
    expect(() => readSessionFile(path)).toThrow(SessionFileError);
    try {
      readSessionFile(path);
    } catch (e) {
      expect((e as SessionFileError).code).toBe("bad-header");
    }
  });

  it("throws SessionFileError code=bad-header for invalid JSON on line 1", () => {
    const path = write("not json\n");
    expect(() => readSessionFile(path)).toThrow(SessionFileError);
    try {
      readSessionFile(path);
    } catch (e) {
      expect((e as SessionFileError).code).toBe("bad-header");
    }
  });

  it("throws SessionFileError code=unknown-version for version != 1", () => {
    const path = write(`${HEADER({ version: 2 })}\n`);
    expect(() => readSessionFile(path)).toThrow(SessionFileError);
    try {
      readSessionFile(path);
    } catch (e) {
      expect((e as SessionFileError).code).toBe("unknown-version");
    }
  });

  it("throws SessionFileError code=corrupt-line on mid-file invalid JSON", () => {
    const path = write(
      [
        HEADER(),
        '{"kind":"user","text":"ok"}',
        "{not-json",
        '{"kind":"herta","text":"hi"}',
        "",
      ].join("\n"),
    );
    expect(() => readSessionFile(path)).toThrow(SessionFileError);
    try {
      readSessionFile(path);
    } catch (e) {
      const err = e as SessionFileError;
      expect(err.code).toBe("corrupt-line");
      expect(err.line).toBe(3);
    }
  });

  it("tolerates a truncated last line (no trailing newline)", () => {
    // Simulate an interrupted write: header + 2 full lines + 1 truncated.
    const path = write(
      [
        HEADER(),
        '{"kind":"user","text":"ok"}',
        '{"kind":"herta","text":"good"}',
        '{"kind":"system","label":"系统","body":"partia', // truncated
      ].join("\n"),
    );
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { record } = readSessionFile(path);
      expect(record).toHaveLength(2);
      expect(record[1]).toEqual({
        kind: "herta",
        surface: "speech",
        text: "good",
      });
      expect(warnSpy).toHaveBeenCalledOnce();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("parses backendWorkspace from the header when present", () => {
    const path = write(
      [
        HEADER({ backendWorkspace: "/ws/abc" }),
        '{"kind":"user","text":"hi"}',
        "",
      ].join("\n"),
    );
    const { meta } = readSessionFile(path);
    expect(meta.backendWorkspace).toBe("/ws/abc");
  });

  it("leaves backendWorkspace undefined for legacy headers", () => {
    const path = write(
      [HEADER(), '{"kind":"user","text":"hi"}', ""].join("\n"),
    );
    const { meta } = readSessionFile(path);
    expect(meta.backendWorkspace).toBeUndefined();
  });

  it("parses lang from the header when present", () => {
    const path = write(
      [HEADER({ lang: "en" }), '{"kind":"user","text":"hi"}', ""].join("\n"),
    );
    expect(readSessionFile(path).meta.lang).toBe("en");
  });

  it("leaves lang undefined for legacy headers and rejects unknown values", () => {
    expect(
      readSessionFile(write([HEADER(), ""].join("\n"))).meta.lang,
    ).toBeUndefined();
    // A malformed lang is dropped, not surfaced — never trust a stray value.
    expect(
      readSessionFile(write([HEADER({ lang: "fr" }), ""].join("\n"))).meta.lang,
    ).toBeUndefined();
  });

  it("keeps a turn_end that describes the tail (audit 2026-07-24, 1.6)", () => {
    const path = write(
      [
        HEADER(),
        '{"kind":"user","text":"hi"}',
        '{"kind":"herta","surface":"speech","text":"好"}',
        '{"_kind":"turn_end","outcome":"interrupted","at":"2026-07-25T00:00:00.000Z"}',
        "",
      ].join("\n"),
    );
    const { record, lastTurnEnd } = readSessionFile(path);
    expect(record).toHaveLength(2);
    expect(lastTurnEnd).toEqual({ outcome: "interrupted", atBlockCount: 2 });
  });

  it("DROPS a turn_end the record outgrew — the crashed-later-turn shape", () => {
    // Turn 1 ended deliberately; turn 2's user block landed and the app
    // died mid-stream. The stale marker must NOT read as "the last turn
    // ended", or resume-recovery never regenerates for any session past its
    // first turn (this is what `atBlockCount <= record.length` got wrong:
    // the covered e2e shape was a FIRST-turn failure, where <= and ===
    // agree).
    const path = write(
      [
        HEADER(),
        '{"kind":"user","text":"turn 1"}',
        '{"kind":"herta","surface":"speech","text":"回复"}',
        '{"_kind":"turn_end","outcome":"completed","at":"2026-07-25T00:00:00.000Z"}',
        '{"kind":"user","text":"turn 2 — app crashed here"}',
        "",
      ].join("\n"),
    );
    const { record, lastTurnEnd } = readSessionFile(path);
    expect(record).toHaveLength(3);
    expect(lastTurnEnd).toBeUndefined();
  });

  it("reads the latest workspace_set line and ignores it as a record block", () => {
    const path = write(
      [
        HEADER(),
        '{"kind":"user","text":"hi"}',
        '{"_kind":"workspace_set","path":"/ws/one","at":"2026-06-15T00:00:00.000Z"}',
        '{"_kind":"workspace_set","path":"/ws/two","at":"2026-06-15T00:01:00.000Z"}',
        "",
      ].join("\n"),
    );
    const { record, latestWorkspaceSet } = readSessionFile(path);
    expect(latestWorkspaceSet).toBe("/ws/two");
    expect(record).toHaveLength(1);
    expect(record[0]).toEqual({ kind: "user", text: "hi" });
  });

  it("the async read parses exactly what the sync read does (ADR 0072 §3)", async () => {
    const path = write(
      [
        HEADER({ lang: "en" }),
        '{"kind":"user","text":"hi","at":"2026-06-18T09:30:00.000Z"}',
        '{"kind":"herta","text":"好"}',
        '{"_kind":"turn_end","outcome":"completed"}',
        '{"_kind":"workspace_set","path":"/ws/one"}',
        "",
      ].join("\n"),
    );
    expect(await readSessionFileAsync(path)).toEqual(readSessionFile(path));
  });

  it("the async read names a missing file not-found", async () => {
    await expect(
      readSessionFileAsync(join(tmp, "missing.jsonl")),
    ).rejects.toMatchObject({ code: "not-found" });
  });
});

describe("readSessionFile — backward compatibility", () => {
  it("defaults missing 'surface' field on herta blocks to 'speech' (pre-Slice-10 sessions)", () => {
    const tmp = join(tmpdir(), `herta-bc-${randomUUID()}.jsonl`);
    const header = JSON.stringify({
      _kind: "session_meta",
      version: 1,
      sessionId: "test",
      startedAt: "2026-01-01T00:00:00.000Z",
      workspaceRoot: "/tmp/ws",
    });
    // Old-shape herta block: no `surface` field.
    const oldHerta = JSON.stringify({ kind: "herta", text: "好。" });
    writeFileSync(tmp, `${header}\n${oldHerta}\n`, "utf-8");

    const { record } = readSessionFile(tmp);
    expect(record).toHaveLength(1);
    expect(record[0]).toEqual({
      kind: "herta",
      surface: "speech",
      text: "好。",
    });
    unlinkSync(tmp);
  });
});
