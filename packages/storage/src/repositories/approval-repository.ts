import type {
  Approval,
  ApprovalStatus,
  CreateApprovalInput,
  ProposedActionDetails,
} from "@harness/core";
import type { HarnessDb } from "../db.ts";
import { newId, nowIso } from "../id.ts";
import { rowToApproval } from "./row-mappers.ts";

export interface ApprovalRepository {
  create(input: CreateApprovalInput): Promise<Approval>;
  listByTaskRun(taskRunId: string): Promise<Approval[]>;
  get(id: string): Promise<Approval | null>;
  decide(
    id: string,
    decision: ApprovalStatus,
    message?: string,
  ): Promise<Approval>;
  setProposedAction(
    id: string,
    details: ProposedActionDetails,
  ): Promise<Approval>;
}

const SELECT_COLUMNS = `id, task_run_id, checkpoint_id, action_type, action_summary, status, decision_message, decided_at, proposed_action_json, policy_evaluation_json`;

export class SqliteApprovalRepository implements ApprovalRepository {
  private readonly db: HarnessDb;

  constructor(db: HarnessDb) {

    this.db = db;

  }

  async create(input: CreateApprovalInput): Promise<Approval> {
    const approval: Approval = {
      id: newId("approval"),
      taskRunId: input.taskRunId,
      checkpointId: input.checkpointId,
      actionType: input.actionType,
      actionSummary: input.actionSummary,
      status: input.status ?? "pending",
    };
    if (input.proposedAction !== undefined) {
      approval.proposedAction = input.proposedAction;
    }
    if (input.policyEvaluation !== undefined) {
      approval.policyEvaluation = input.policyEvaluation;
    }

    this.db
      .prepare(
        `INSERT INTO approvals(id, task_run_id, checkpoint_id, action_type, action_summary, status, decision_message, decided_at, proposed_action_json, policy_evaluation_json)
         VALUES(@id, @taskRunId, @checkpointId, @actionType, @actionSummary, @status, NULL, NULL, @proposedActionJson, @policyEvaluationJson)`,
      )
      .run({
        id: approval.id,
        taskRunId: approval.taskRunId,
        checkpointId: approval.checkpointId,
        actionType: approval.actionType,
        actionSummary: approval.actionSummary,
        status: approval.status,
        proposedActionJson:
          approval.proposedAction !== undefined
            ? JSON.stringify(approval.proposedAction)
            : null,
        policyEvaluationJson:
          approval.policyEvaluation !== undefined
            ? JSON.stringify(approval.policyEvaluation)
            : null,
      });

    return approval;
  }

  async listByTaskRun(taskRunId: string): Promise<Approval[]> {
    const rows = this.db
      .prepare(
        `SELECT ${SELECT_COLUMNS}
         FROM approvals WHERE task_run_id = ?
         ORDER BY id ASC`,
      )
      .all(taskRunId) as Parameters<typeof rowToApproval>[0][];
    return rows.map(rowToApproval);
  }

  async get(id: string): Promise<Approval | null> {
    const row = this.db
      .prepare(
        `SELECT ${SELECT_COLUMNS}
         FROM approvals WHERE id = ?`,
      )
      .get(id) as Parameters<typeof rowToApproval>[0] | undefined;
    return row ? rowToApproval(row) : null;
  }

  async decide(
    id: string,
    decision: ApprovalStatus,
    message?: string,
  ): Promise<Approval> {
    const existing = await this.get(id);
    if (!existing) throw new Error(`Approval ${id} not found`);
    const next: Approval = { ...existing, status: decision };
    if (message !== undefined) next.decisionMessage = message;
    next.decidedAt = nowIso();

    this.db
      .prepare(
        `UPDATE approvals
         SET status=@status, decision_message=@decisionMessage, decided_at=@decidedAt
         WHERE id=@id`,
      )
      .run({
        id: next.id,
        status: next.status,
        decisionMessage: next.decisionMessage ?? null,
        decidedAt: next.decidedAt ?? null,
      });
    return next;
  }

  async setProposedAction(
    id: string,
    details: ProposedActionDetails,
  ): Promise<Approval> {
    const existing = await this.get(id);
    if (!existing) throw new Error(`Approval ${id} not found`);
    this.db
      .prepare(
        `UPDATE approvals SET proposed_action_json=? WHERE id=?`,
      )
      .run(JSON.stringify(details), id);
    return { ...existing, proposedAction: details };
  }
}
