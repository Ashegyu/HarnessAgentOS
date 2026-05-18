import type {
  Approval,
  ApprovalDecisionOptions,
  ApprovalStatus,
  CreateApprovalInput,
  DecisionLogInput,
  DecisionLogPage,
  DecisionLogFilter,
  ProposedActionDetails,
} from "@harness/core";
import type { HarnessDb } from "../db.ts";
import { newId, nowIso } from "../id.ts";
import { rowToApproval } from "./row-mappers.ts";

export interface ApprovalRepository {
  create(input: CreateApprovalInput): Promise<Approval>;
  listByTaskRun(taskRunId: string): Promise<Approval[]>;
  get(id: string): Promise<Approval | null>;
  listAllWithDecisionTrace(input: DecisionLogInput): Promise<DecisionLogPage>;
  decide(
    id: string,
    decision: ApprovalStatus,
    message?: string,
    options?: ApprovalDecisionOptions,
  ): Promise<Approval>;
  setProposedAction(
    id: string,
    details: ProposedActionDetails,
  ): Promise<Approval>;
}

const SELECT_COLUMNS = `id, task_run_id, checkpoint_id, action_type, action_summary, status, decision_message, decided_at, proposed_action_json, policy_evaluation_json, auto_approve_decision_json`;
const SELECT_COLUMNS_PREFIXED = `a.id, a.task_run_id, a.checkpoint_id, a.action_type, a.action_summary, a.status, a.decision_message, a.decided_at, a.proposed_action_json, a.policy_evaluation_json, a.auto_approve_decision_json`;

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
      autoApproveDecision: null,
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

  async listAllWithDecisionTrace(
    input: DecisionLogInput,
  ): Promise<DecisionLogPage> {
    const limit = clampPageSize(input.limit);
    const offset = clampOffset(input.offset);
    const where = buildDecisionLogWhere(input.filter);
    const totalRow = this.db
      .prepare(
        `SELECT COUNT(*) AS total
         FROM approvals a
         INNER JOIN task_runs tr ON tr.id = a.task_run_id
         INNER JOIN threads th ON th.id = tr.thread_id
         WHERE ${where.sql}`,
      )
      .get(...where.params) as { total: number };
    const rows = this.db
      .prepare(
        `SELECT
           ${SELECT_COLUMNS_PREFIXED},
           th.id AS thread_id,
           th.title AS thread_title,
           tr.user_request AS task_run_user_request,
           tr.status AS task_run_status
         FROM approvals a
         INNER JOIN task_runs tr ON tr.id = a.task_run_id
         INNER JOIN threads th ON th.id = tr.thread_id
         WHERE ${where.sql}
         ORDER BY a.decided_at DESC, a.id DESC
         LIMIT ? OFFSET ?`,
      )
      .all(...where.params, limit, offset) as Array<
      Parameters<typeof rowToApproval>[0] & {
        thread_id: string;
        thread_title: string;
        task_run_user_request: string;
        task_run_status: DecisionLogPage["items"][number]["taskRunStatus"];
      }
    >;

    const items = rows.flatMap((row) => {
      const approval = rowToApproval(row);
      if (!approval.autoApproveDecision || !approval.decidedAt) return [];
      return [
        {
          approval: {
            ...approval,
            autoApproveDecision: approval.autoApproveDecision,
            decidedAt: approval.decidedAt,
          },
          threadId: row.thread_id,
          threadTitle: row.thread_title,
          taskRunId: approval.taskRunId,
          taskRunUserRequest: row.task_run_user_request,
          taskRunStatus: row.task_run_status,
        },
      ];
    });

    const total = totalRow.total;
    return {
      items,
      total,
      limit,
      offset,
      hasNext: offset + limit < total,
    };
  }

  async decide(
    id: string,
    decision: ApprovalStatus,
    message?: string,
    options?: ApprovalDecisionOptions,
  ): Promise<Approval> {
    const existing = await this.get(id);
    if (!existing) throw new Error(`Approval ${id} not found`);
    const next: Approval = { ...existing, status: decision };
    if (message !== undefined) next.decisionMessage = message;
    next.decidedAt = nowIso();
    const hasAutoApproveDecisionPatch =
      options !== undefined &&
      Object.prototype.hasOwnProperty.call(options, "autoApproveDecision");
    next.autoApproveDecision = hasAutoApproveDecisionPatch
      ? (options.autoApproveDecision ?? null)
      : (existing.autoApproveDecision ?? null);

    this.db
      .prepare(
        `UPDATE approvals
         SET status=@status,
             decision_message=@decisionMessage,
             decided_at=@decidedAt,
             auto_approve_decision_json=@autoApproveDecisionJson
         WHERE id=@id`,
      )
      .run({
        id: next.id,
        status: next.status,
        decisionMessage: next.decisionMessage ?? null,
        decidedAt: next.decidedAt ?? null,
        autoApproveDecisionJson:
          next.autoApproveDecision !== null &&
          next.autoApproveDecision !== undefined
            ? JSON.stringify(next.autoApproveDecision)
            : null,
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

const clampPageSize = (value: number): number => {
  if (!Number.isInteger(value)) return 50;
  return Math.max(1, Math.min(100, value));
};

const clampOffset = (value: number): number => {
  if (!Number.isInteger(value)) return 0;
  return Math.max(0, value);
};

const buildDecisionLogWhere = (
  filter: DecisionLogFilter | undefined,
): { sql: string; params: unknown[] } => {
  const clauses = [
    "a.auto_approve_decision_json IS NOT NULL",
    "a.decided_at IS NOT NULL",
    "json_valid(a.auto_approve_decision_json) = 1",
  ];
  const params: unknown[] = [];

  if (filter?.decidedAtSteps !== undefined) {
    if (filter.decidedAtSteps.length === 0) {
      clauses.push("1 = 0");
    } else {
      clauses.push(
        `json_extract(a.auto_approve_decision_json, '$.decidedAt') IN (${placeholders(
          filter.decidedAtSteps.length,
        )})`,
      );
      params.push(...filter.decidedAtSteps);
    }
  }

  if (filter?.actionTypes !== undefined) {
    if (filter.actionTypes.length === 0) {
      clauses.push("1 = 0");
    } else {
      clauses.push(`a.action_type IN (${placeholders(filter.actionTypes.length)})`);
      params.push(...filter.actionTypes);
    }
  }

  if (filter?.sinceIso) {
    clauses.push("a.decided_at >= ?");
    params.push(filter.sinceIso);
  }

  if (filter?.untilIso) {
    clauses.push("a.decided_at < ?");
    params.push(filter.untilIso);
  }

  return { sql: clauses.join(" AND "), params };
};

const placeholders = (count: number): string =>
  Array.from({ length: count }, () => "?").join(",");
