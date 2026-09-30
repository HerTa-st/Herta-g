import { describe, expect, it } from "vitest";
import { ExecutionReportBuilder } from "./report-builder.js";
import type { AgentExecutionReport, EvidenceItem } from "./types.js";

describe("ExecutionReportBuilder", () => {
  it("builds a minimal completed report with one evidence item", () => {
    const report: AgentExecutionReport = new ExecutionReportBuilder("t-1")
      .setStatus("completed")
      .addEvidence({
        kind: "test",
        summary: "tests/parser.spec.ts: 1 passed",
      })
      .build();

    expect(report.taskId).toBe("t-1");
    expect(report.status).toBe("completed");
    expect(report.evidence).toHaveLength(1);
    expect(report.evidence[0]?.kind).toBe("test");
    expect(report.changedFiles).toEqual([]);
    expect(report.tests).toEqual([]);
    expect(report.permissions).toEqual([]);
    expect(report.residualRisks).toEqual([]);
    // The structural assertion: no `summary` property — the backend doesn't
    // write a self-paraphrase that Herta would re-render.
    expect("summary" in report).toBe(false);
    // Nor a todo carry-over (ADR 0073): the list it came from is gone.
    expect("nextActions" in report).toBe(false);
  });

  it("accumulates entries across all collection adders", () => {
    const report = new ExecutionReportBuilder("t-2")
      .setStatus("partial")
      .addChangedFile({
        path: "src/parser.ts",
        kind: "modified",
        diffSummary: "+3 -1",
      })
      .addEvidence({ kind: "file", summary: "src/parser.ts read" })
      .addEvidence({ kind: "command", summary: "pnpm test parser" })
      .addTest({
        command: "pnpm test parser",
        status: "passed",
        summary: "1 passed",
      })
      .addPermission({
        tool: "edit_file",
        risk: "medium",
        decision: "allow",
        summary: "approved by user",
      })
      .addResidualRisk("full suite not run")
      .build();

    expect(report.changedFiles).toHaveLength(1);
    expect(report.evidence).toHaveLength(2);
    expect(report.tests).toHaveLength(1);
    expect(report.permissions).toHaveLength(1);
    expect(report.residualRisks).toEqual(["full suite not run"]);
  });

  it("returns independent arrays per build call", () => {
    const builder = new ExecutionReportBuilder("t-3")
      .setStatus("completed")
      .addEvidence({ kind: "tool", summary: "ok" });

    const first = builder.build();
    const second = builder.build();

    expect(first.evidence).not.toBe(second.evidence);
    expect(first.evidence).toEqual(second.evidence);

    (first.evidence as EvidenceItem[]).push({
      kind: "tool",
      summary: "mutated",
    });
    const third = builder.build();
    expect(third.evidence).toHaveLength(1);
  });
});

describe("ExecutionReportBuilder validation", () => {
  it("rejects a completed report with no evidence, tests, or changed files", () => {
    const builder = new ExecutionReportBuilder("t-bad").setStatus("completed");
    expect(() => builder.build()).toThrow(/completed/i);
  });

  it("accepts a completed report when only changedFiles is non-empty", () => {
    const report = new ExecutionReportBuilder("t-cf")
      .setStatus("completed")
      .addChangedFile({
        path: "src/x.ts",
        kind: "modified",
        diffSummary: "+1 -1",
      })
      .build();
    expect(report.status).toBe("completed");
  });

  it("accepts a completed report when only tests is non-empty", () => {
    const report = new ExecutionReportBuilder("t-tests")
      .setStatus("completed")
      .addTest({
        command: "pnpm test parser",
        status: "passed",
        summary: "1 passed",
      })
      .build();
    expect(report.status).toBe("completed");
  });

  it.each([
    "blocked",
    "failed",
    "partial",
  ] as const)("accepts %s with empty collections", (status) => {
    const report = new ExecutionReportBuilder(`t-${status}`)
      .setStatus(status)
      .build();
    expect(report.status).toBe(status);
  });

  it("rejects an empty taskId", () => {
    expect(() => new ExecutionReportBuilder("").build()).toThrow(/taskId/i);
  });
});
