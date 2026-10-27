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
  claimExecution(id: string, revision: number, token: string): Promise<Approval>;
  finishExecution(id: string, token: string, outcome: "succeeded" | "failed" | "uncertain"): Promise<void>;
  create(input: CreateApprovalInput): Promise<Approval>;
  listByTaskRun(taskRunId: string, order?: "display" | "execution"): Promise<Approval[]>;
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

const SELECT_COLUMNS = `id, task_run_id, checkpoint_id, action_type, action_summary, status, decision_message, decided_at, proposed_action_json, policy_evaluation_json, auto_approve_decision_json, action_revision, approved_revision, requires_manual_approval, execution_state, execution_started_at, execution_finished_at, retry_approval_id`;
const SELECT_COLUMNS_PREFIXED = SELECT_COLUMNS.split(", ").map(column => `a.${column}`).join(", ");

export class SqliteApprovalRepository implements ApprovalRepository {
  private readonly db: HarnessDb;

  constructor(db: HarnessDb) {

    this.db = db;

  }

  async create(input: CreateApprovalInput): Promise<Approval> {
    const id = this.insert(input);
    return (await this.get(id))!;
  }

  createSync(input: CreateApprovalInput): Approval {
    return this.getSync(this.insert(input))!;
  }

  private insert(input: CreateApprovalInput): string {
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

    // Only trusted service callers can seed an already-approved record.
    if (approval.status === "approved" || approval.status === "always_approved_for_run") {
      this.db.prepare(`UPDATE approvals SET approved_revision=action_revision,
        approved_action_json=proposed_action_json WHERE id=?`).run(approval.id);
    }
    return approval.id;
  }

  async listByTaskRun(taskRunId: string, order: "display" | "execution" = "display"): Promise<Approval[]> {
    const ordering = order === "execution" ? "rowid ASC" :
      "CASE WHEN decided_at IS NULL THEN 1 ELSE 0 END ASC, datetime(decided_at) DESC, rowid DESC";
    const rows = this.db
      .prepare(
        `SELECT ${SELECT_COLUMNS}
         FROM approvals WHERE task_run_id = ?
         ORDER BY ${ordering}`,
      )
      .all(taskRunId) as Parameters<typeof rowToApproval>[0][];
    return rows.map(rowToApproval);
  }

  async get(id: string): Promise<Approval | null> {
    return this.getSync(id);
  }

  getSync(id: string): Approval | null {
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
    if (existing.retryApprovalId) throw new Error("APPROVAL_TRANSITION_LOCKED: approval was replaced after review");
    if (options?.expectedRevision !== undefined && options.expectedRevision !== existing.actionRevision) {
      throw new Error("APPROVAL_REVISION_MISMATCH: refresh the approval before deciding");
    }
    const approving = decision === "approved" || decision === "always_approved_for_run";
    if (approving && (existing.status !== "pending" || existing.executionState)) {
      throw new Error("APPROVAL_TRANSITION_LOCKED: only an unexecuted pending approval may be approved");
    }
    if (decision === "rejected" && (existing.executionState || existing.status === "executed" || existing.status === "rejected")) {
      throw new Error("APPROVAL_TRANSITION_LOCKED");
    }
    if (decision === "pending") throw new Error("APPROVAL_TRANSITION_LOCKED: create a new approval");
    const next: Approval = { ...existing, status: decision };
    if (message !== undefined) next.decisionMessage = message;
    next.decidedAt = nowIso();
    const hasAutoApproveDecisionPatch =
      options !== undefined &&
      Object.prototype.hasOwnProperty.call(options, "autoApproveDecision");
    next.autoApproveDecision = hasAutoApproveDecisionPatch
      ? (options.autoApproveDecision ?? null)
      : (existing.autoApproveDecision ?? null);

    const updated = this.db
      .prepare(
        `UPDATE approvals
         SET status=@status,
             decision_message=@decisionMessage,
             decided_at=@decidedAt,
             auto_approve_decision_json=@autoApproveDecisionJson,
             approved_revision=CASE WHEN @approving THEN action_revision ELSE approved_revision END,
             approved_action_json=CASE WHEN @approving THEN proposed_action_json ELSE approved_action_json END
         WHERE id=@id AND action_revision=@revision AND status=@previousStatus AND retry_approval_id IS NULL
           AND (@approving=0 OR execution_state IS NULL)
           AND EXISTS (SELECT 1 FROM task_runs WHERE id=approvals.task_run_id AND status NOT IN ('done','cancelled'))`,
      )
      .run({
        id: next.id,
        approving: approving ? 1 : 0,
        revision: existing.actionRevision ?? 1,
        previousStatus: existing.status,
        status: next.status,
        decisionMessage: next.decisionMessage ?? null,
        decidedAt: next.decidedAt ?? null,
        autoApproveDecisionJson:
          next.autoApproveDecision !== null &&
          next.autoApproveDecision !== undefined
            ? JSON.stringify(next.autoApproveDecision)
            : null,
      });
    if (updated.changes !== 1) throw new Error("APPROVAL_TRANSITION_LOCKED: approval changed or task is terminal");
    return (await this.get(id))!;
  }

  async setProposedAction(
    id: string,
    details: ProposedActionDetails,
  ): Promise<Approval> {
    const existing = await this.get(id);
    if (!existing) throw new Error(`Approval ${id} not found`);
    if (existing.retryApprovalId || existing.executionState || existing.status === "executed" || existing.status === "rejected") {
      throw new Error("APPROVAL_ACTION_LOCKED: create a new approval after reviewing the previous attempt");
    }
    const updated = this.db
      .prepare(
        `UPDATE approvals SET proposed_action_json=?, action_revision=action_revision+1,
          requires_manual_approval=CASE WHEN status IN ('approved','always_approved_for_run') THEN 1 ELSE requires_manual_approval END,
          status='pending', approved_revision=NULL, approved_action_json=NULL,
          auto_approve_decision_json=NULL
          WHERE id=? AND action_revision=? AND execution_state IS NULL AND retry_approval_id IS NULL AND status NOT IN ('executed','rejected')
          AND EXISTS (SELECT 1 FROM task_runs WHERE id=approvals.task_run_id AND status NOT IN ('done','cancelled'))`,
      )
      .run(JSON.stringify(details), id, existing.actionRevision ?? 1);
    if (updated.changes !== 1) throw new Error("APPROVAL_ACTION_LOCKED");
    return (await this.get(id))!;
  }

  async claimExecution(id: string, revision: number, token: string): Promise<Approval> {
    const claimed = this.db.prepare(`UPDATE approvals SET execution_state='running', execution_token=?, execution_started_at=?
      WHERE id=? AND action_revision=? AND approved_revision=action_revision
        AND approved_action_json=proposed_action_json AND execution_state IS NULL AND retry_approval_id IS NULL
        AND status IN ('approved','always_approved_for_run')
        AND EXISTS (SELECT 1 FROM task_runs WHERE id=approvals.task_run_id AND status NOT IN ('done','cancelled'))`)
      .run(token, nowIso(), id, revision);
    if (claimed.changes !== 1) throw new Error("APPROVAL_CLAIM_LOCKED: already running, consumed, changed, or task terminal");
    return (await this.get(id))!;
  }

  async finishExecution(id: string, token: string, outcome: "succeeded" | "failed" | "uncertain"): Promise<void> {
    this.db.prepare(`UPDATE approvals SET execution_state=@outcome, execution_finished_at=@finished,
        status=CASE WHEN @outcome='failed' THEN 'executed' ELSE status END,
        decision_message=CASE WHEN @outcome='failed' THEN '검사 실행 종료 — 실패 결과가 기록되었습니다. 이 승인은 재실행할 수 없습니다.' ELSE decision_message END
      WHERE id=@id AND execution_token=@token AND execution_state='running'`)
      .run({ outcome, finished: nowIso(), id, token });
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
