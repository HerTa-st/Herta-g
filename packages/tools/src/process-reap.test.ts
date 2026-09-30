import { describe, expect, it } from "vitest";
import { type ProcessRow, processTree } from "./process-reap.js";

const row = (
  pid: number,
  startedAt: number,
  ppid = 0,
  pgid = pid,
): ProcessRow => ({ pid, ppid, pgid, startedAt });

const ROOT = { pid: 11, startedAt: 10_000 };

describe("processTree (ADR 0071 §1.6)", () => {
  describe("windows: the recorded process and its descendants by parent id", () => {
    const tree = (rows: ProcessRow[]) => processTree(rows, ROOT, "win32");

    it("the process itself when it still runs as that process, and what it started", () => {
      expect(
        tree([row(11, 10_100), row(21, 10_200, 11), row(31, 10_300, 21)]),
      ).toEqual([11, 21, 31]);
    });

    it("a launcher that exited still leads to the shell and command it left", () => {
      expect(tree([row(21, 10_050, 11), row(31, 60_000, 21)])).toEqual([
        21, 31,
      ]);
    });

    it("never a process older than its supposed parent", () => {
      expect(tree([row(21, 2_000, 11)])).toEqual([]);
    });

    it("a reused pid: the later holder and its children are someone else's; ours from before stay ours", () => {
      expect(
        tree([
          row(11, 900_000), // pid 11 now names a later process
          row(22, 900_100, 11), // started by it
          row(23, 20_000, 11), // started by ours, before the reuse
        ]),
      ).toEqual([23]);
    });

    it("nothing when nothing of it runs", () => {
      expect(tree([row(99, 10_000)])).toEqual([]);
    });

    it("a gone parent's children are ours only if they started while the run's app lived (review 2026-09-30)", () => {
      // pid 11 is free again. 21 started under it while the app lived; 22
      // started under it long after — a later holder of pid 11 started it and
      // exited, and nothing else tells them apart.
      const rows = [row(21, 10_050, 11), row(22, 900_100, 11)];
      expect(processTree(rows, ROOT, "win32", { notAfter: 60_000 })).toEqual([
        21,
      ]);
      // The window still applies: a child stamped just past the bound is ours.
      expect(processTree(rows, ROOT, "win32", { notAfter: 895_500 })).toEqual([
        21, 22,
      ]);
      // Without the bound the old answer stands.
      expect(processTree(rows, ROOT, "win32")).toEqual([21, 22]);
      // A parent still running as itself needs no bound: its children are its.
      expect(
        processTree(
          [row(11, 10_000), row(22, 900_100, 11), row(33, 950_000, 22)],
          ROOT,
          "win32",
          { notAfter: 60_000 },
        ),
      ).toEqual([11, 22, 33]);
      // Once a child is found running, its own children are its, bound or not.
      expect(
        processTree(
          [row(21, 10_050, 11), row(31, 900_000, 21)],
          ROOT,
          "win32",
          { notAfter: 60_000 },
        ),
      ).toEqual([21, 31]);
    });
  });

  describe("posix: the recorded process and its process group", () => {
    const tree = (rows: ProcessRow[]) => processTree(rows, ROOT, "linux");

    it("the leader and its group, orphans included", () => {
      expect(
        tree([row(11, 10_000), row(21, 10_200, 1, 11), row(31, 10_300, 1, 11)]),
      ).toEqual([11, 21, 31]);
      // The leader exited: its group is still reachable.
      expect(tree([row(21, 10_200, 1, 11)])).toEqual([21]);
    });

    it("a reused pid means the group had emptied: nothing is ours", () => {
      expect(tree([row(11, 900_000), row(21, 900_100, 11, 11)])).toEqual([]);
    });

    it("never a member older than the run's process", () => {
      expect(tree([row(21, 2_000, 1, 11)])).toEqual([]);
    });
  });
});
