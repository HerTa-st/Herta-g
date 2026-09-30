import type {
  AgentExecutionReport,
  ChangedFileSummary,
  EvidenceItem,
  ExecutionStatus,
  PermissionEventSummary,
  TestRunSummary,
} from "./types.js";

export class ExecutionReportBuilder {
  /**
   * Default `"partial"` is the explicit "no terminal claim" state.
   * Callers must call `setStatus("completed")` to claim success;
   * the validator only enforces evidence on `"completed"`.
   */
  private status: ExecutionStatus = "partial";
  private readonly changedFiles: ChangedFileSummary[] = [];
  private readonly evidence: EvidenceItem[] = [];
  private readonly tests: TestRunSummary[] = [];
  private readonly permissions: PermissionEventSummary[] = [];
  private readonly residualRisks: string[] = [];
  /** Run-level risks — why the run ended, what the harness stopped, what it
   *  could not attribute — listed ahead of the per-tool ones, so a reader
   *  that shows only the first few (the done-marker shows five) keeps them. */
  private readonly leadingRisks: string[] = [];
  private endedBy: AgentExecutionReport["endedBy"];

  constructor(private readonly taskId: string) {}

  setStatus(status: ExecutionStatus): this {
    this.status = status;
    return this;
  }

  addChangedFile(file: ChangedFileSummary): this {
    this.changedFiles.push(file);
    return this;
  }

  addEvidence(item: EvidenceItem): this {
    this.evidence.push(item);
    return this;
  }

  addTest(test: TestRunSummary): this {
    this.tests.push(test);
    return this;
  }

  addPermission(permission: PermissionEventSummary): this {
    this.permissions.push(permission);
    return this;
  }

  addResidualRisk(
    risk: string,
    opts: { readonly leading?: boolean } = {},
  ): this {
    (opts.leading === true ? this.leadingRisks : this.residualRisks).push(risk);
    return this;
  }

  /** How the run ended, when it was not the model's own finish (see
   *  `AgentExecutionReport.endedBy`). */
  setEndedBy(endedBy: NonNullable<AgentExecutionReport["endedBy"]>): this {
    this.endedBy = endedBy;
    return this;
  }

  build(): AgentExecutionReport {
    if (this.taskId.length === 0) {
      throw new Error("ExecutionReportBuilder: taskId must be non-empty");
    }
    if (
      this.status === "completed" &&
      this.changedFiles.length === 0 &&
      this.evidence.length === 0 &&
      this.tests.length === 0
    ) {
      throw new Error(
        "ExecutionReportBuilder: status 'completed' requires at least one evidence item, test, or changed file",
      );
    }
    return {
      taskId: this.taskId,
      status: this.status,
      changedFiles: [...this.changedFiles],
      evidence: [...this.evidence],
      tests: [...this.tests],
      permissions: [...this.permissions],
      residualRisks: [...this.leadingRisks, ...this.residualRisks],
      ...(this.endedBy !== undefined ? { endedBy: this.endedBy } : {}),
    };
  }
}
