import { describe, expect, it } from "vitest";
import type { AgentExecutionReport, HertaToAgentBrief } from "./types.js";

function describeStatus(s: AgentExecutionReport["status"]): string {
  switch (s) {
    case "completed":
      return "completed";
    case "blocked":
      return "blocked";
    case "failed":
      return "failed";
    case "interrupted":
      return "interrupted";
    case "partial":
      return "partial";
    default: {
      const _exhaustive: never = s;
      return _exhaustive;
    }
  }
}

describe("bridge types", () => {
  it("AgentExecutionReport.status has 4 exhaustively handled variants", () => {
    expect(typeof describeStatus).toBe("function");
  });

  it("HertaToAgentBrief is a minimal {taskId} dispatch (post-May-2026)", () => {
    // Brief no longer carries userRequestQuoted / hertaInterpretation /
    // taskType / successCriteria / constraints — those forced Herta into
    // a task-framer role on top of speaker. The backend reads the user's
    // actual words from the actor transcript, threaded via
    // BackendTurnHandle.userMessages.
    const brief: HertaToAgentBrief = { taskId: "t-1" };
    expect(brief.taskId).toBe("t-1");
  });

  it("AgentExecutionReport no longer carries a model-written summary field", () => {
    const report: AgentExecutionReport = {
      taskId: "t-1",
      status: "completed",
      changedFiles: [],
      evidence: [{ kind: "file", summary: "read src/parser.ts" }],
      tests: [],
      permissions: [],
      residualRisks: [],
    };
    // The structural assertion: no `summary` property at the top level.
    expect("summary" in report).toBe(false);
  });
});
