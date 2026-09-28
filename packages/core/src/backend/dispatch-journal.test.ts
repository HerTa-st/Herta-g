import {
  appendFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DISPATCH_JOURNAL_VERSION,
  DispatchJournal,
  type DispatchJournalEntry,
  dispatchJournalPath,
  type JournalStartEntry,
  journalUnavailableResult,
  parseDispatchJournal,
  readDispatchJournal,
} from "./dispatch-journal.js";

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "herta-journal-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) {
    rmSync(d, { recursive: true, force: true, maxRetries: 3 });
  }
});

function start(taskId = "task-1"): JournalStartEntry {
  return {
    kind: "start",
    v: DISPATCH_JOURNAL_VERSION,
    taskId,
    at: "2026-09-28T10:00:00.000Z",
    contract: "minimal",
    recordLength: 7,
    brief: { taskId },
    frame: {
      userMessages: [{ text: "fix the parser" }],
      omittedUserMessages: 0,
      scopedRepoInstructions: "",
      scopedMemory: "",
      recentDialogue: "",
      workingHistory: "",
      lang: "zh",
    },
  };
}

describe("the run journal (ADR 0071 §1.1)", () => {
  it("lives in a journal/ folder beside the session records", () => {
    expect(dispatchJournalPath("/t", "s1").replaceAll("\\", "/")).toBe(
      "/t/journal/s1.jsonl",
    );
  });

  it("records entries in order, the start first, and reads them back", async () => {
    const path = dispatchJournalPath(tmp(), "s1");
    const j = await DispatchJournal.begin(path, start());
    expect(j.failed).toBe(false);
    void j.append({
      kind: "message",
      message: {
        role: "assistant",
        text: "",
        toolCalls: [{ id: "c1", tool: "edit_file", input: {} }],
        ts: "t",
      },
    });
    await j.appendDurable({ kind: "dispatch", callIds: ["c1"] });
    await j
      .forCall("c1")
      .recordWrite({ path: "/w/a.ts", before: "aa", after: "bb" });
    j.forCall("c2").recordSpawn({
      pid: 4242,
      command: "npm test",
      role: "foreground",
    });
    j.forCall("c2").recordExit(4242);
    await j.append({ kind: "end", status: "completed" });
    await j.close();

    const back = await readDispatchJournal(path);
    expect(back?.map((e) => e.kind)).toEqual([
      "start",
      "message",
      "dispatch",
      "write",
      "spawn",
      "exit",
      "end",
    ]);
    expect(back?.[3]).toEqual({
      kind: "write",
      callId: "c1",
      path: "/w/a.ts",
      before: "aa",
      after: "bb",
    });
    expect(back?.[4]).toMatchObject({
      kind: "spawn",
      callId: "c2",
      pid: 4242,
      role: "foreground",
    });
  });

  it("a new dispatch replaces the previous journal", async () => {
    const path = dispatchJournalPath(tmp(), "s1");
    const first = await DispatchJournal.begin(path, start("task-1"));
    await first.append({ kind: "end", status: "completed" });
    await first.close();
    const second = await DispatchJournal.begin(path, start("task-2"));
    await second.close();
    const back = await readDispatchJournal(path);
    expect(back).toHaveLength(1);
    expect(back?.[0]).toMatchObject({ kind: "start", taskId: "task-2" });
  });

  it("reads null when there is no journal", async () => {
    expect(await readDispatchJournal(join(tmp(), "none.jsonl"))).toBeNull();
  });

  it("survives a crash at any byte: every cut reads back as a prefix of the entries", async () => {
    // The app can die in the middle of any write. Whatever was on disk must
    // read as the run's own entries, in order — never a garbled one.
    const path = dispatchJournalPath(tmp(), "s1");
    const j = await DispatchJournal.begin(path, start());
    const entries: DispatchJournalEntry[] = [
      { kind: "dispatch", callIds: ["c1"] },
      {
        kind: "write",
        callId: "c1",
        path: "/w/a.ts",
        before: null,
        after: "ff",
      },
      {
        kind: "spawn",
        callId: "c2",
        pid: 7,
        startedAt: 1,
        command: "x",
        role: "shell",
      },
      { kind: "exit", pid: 7 },
      { kind: "end", status: "completed" },
    ];
    for (const e of entries) await j.appendDurable(e);
    await j.close();
    const full = readFileSync(path);
    const all = await readDispatchJournal(path);
    // Every byte offset, parsed in memory (a file per cut is a thousand
    // round trips). A cut inside a UTF-8 sequence decodes as a replacement
    // character, and its line is torn anyway.
    let complete = 0;
    for (let n = 0; n <= full.length; n += 1) {
      const back = parseDispatchJournal(full.subarray(0, n).toString("utf8"));
      expect(back).toEqual(all?.slice(0, back.length));
      complete = Math.max(complete, back.length);
    }
    expect(complete).toBe(all?.length);
  });

  it("skips a torn last line", async () => {
    const path = dispatchJournalPath(tmp(), "s1");
    const j = await DispatchJournal.begin(path, start());
    await j.appendDurable({ kind: "dispatch", callIds: ["c1"] });
    await j.close();
    appendFileSync(path, '{"kind":"write","callId":"c1","pa');
    expect((await readDispatchJournal(path))?.map((e) => e.kind)).toEqual([
      "start",
      "dispatch",
    ]);
  });

  it("fails closed: a journal that cannot be created refuses every durable append", async () => {
    const d = tmp();
    // The journal folder's place is taken by a FILE, so nothing can be made.
    writeFileSync(join(d, "journal"), "not a directory");
    const j = await DispatchJournal.begin(
      dispatchJournalPath(d, "s1"),
      start(),
    );
    expect(j.failed).toBe(true);
    await expect(
      j.appendDurable({ kind: "dispatch", callIds: ["c1"] }),
    ).rejects.toThrow();
    await expect(
      j.forCall("c1").recordWrite({ path: "/w/a", before: null, after: "x" }),
    ).rejects.toThrow();
    // A plain append never rejects — it latches instead.
    await expect(
      j.append({ kind: "end", status: "completed" }),
    ).resolves.toBeUndefined();
    await j.close();
  });

  it("a closed journal refuses durable appends and writes nothing more", async () => {
    const path = dispatchJournalPath(tmp(), "s1");
    const j = await DispatchJournal.begin(path, start());
    await j.close();
    await expect(
      j.appendDurable({ kind: "dispatch", callIds: ["c1"] }),
    ).rejects.toThrow();
    await j.append({ kind: "end", status: "completed" });
    expect((await readDispatchJournal(path))?.map((e) => e.kind)).toEqual([
      "start",
    ]);
  });

  it("the refusal a call gets says the step was not performed and not to retry it", () => {
    const r = journalUnavailableResult("ENOSPC");
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("journal_unavailable");
    expect(r.error?.message).toContain("not performed");
    expect(r.suggestion).toContain("do not retry");
  });
});
