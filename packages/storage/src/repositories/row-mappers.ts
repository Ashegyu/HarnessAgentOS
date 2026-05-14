import type {
  Approval,
  ApprovalActionType,
  ApprovalStatus,
  Artifact,
  ArtifactKind,
  Checkpoint,
  CheckpointReason,
  Step,
  StepKind,
  StepStatus,
  TaskRun,
  TaskRunStatus,
  Thread,
} from "@harness/core";

/**
 * SQLite row → domain object converters. Centralized so the snake_case
 * SQL column names never leak past the storage package.
 */

interface ThreadRow {
  id: string;
  title: string;
  target_dir: string | null;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
  agent_session_id?: string | null;
  pipeline_id?: string | null;
}

export const rowToThread = (r: ThreadRow): Thread => {
  const t: Thread = {
    id: r.id,
    title: r.title,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
  if (r.target_dir !== null) t.targetDir = r.target_dir;
  if (r.archived_at !== null) t.archivedAt = r.archived_at;
  if (r.agent_session_id !== null && r.agent_session_id !== undefined) {
    t.agentSessionId = r.agent_session_id;
  }
  if (r.pipeline_id !== null && r.pipeline_id !== undefined) {
    t.pipelineId = r.pipeline_id;
  }
  return t;
};

interface TaskRunRow {
  id: string;
  thread_id: string;
  user_request: string;
  target_dir: string;
  status: TaskRunStatus;
  current_step_id: string | null;
  created_at: string;
  updated_at: string;
}

export const rowToTaskRun = (r: TaskRunRow): TaskRun => {
  const t: TaskRun = {
    id: r.id,
    threadId: r.thread_id,
    userRequest: r.user_request,
    targetDir: r.target_dir,
    status: r.status,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
  if (r.current_step_id !== null) t.currentStepId = r.current_step_id;
  return t;
};

interface StepRow {
  id: string;
  task_run_id: string;
  step_index: number;
  kind: StepKind;
  title: string;
  status: StepStatus;
  input_summary: string | null;
  output_summary: string | null;
  started_at: string | null;
  finished_at: string | null;
}

export const rowToStep = (r: StepRow): Step => {
  const s: Step = {
    id: r.id,
    taskRunId: r.task_run_id,
    index: r.step_index,
    kind: r.kind,
    title: r.title,
    status: r.status,
  };
  if (r.input_summary !== null) s.inputSummary = r.input_summary;
  if (r.output_summary !== null) s.outputSummary = r.output_summary;
  if (r.started_at !== null) s.startedAt = r.started_at;
  if (r.finished_at !== null) s.finishedAt = r.finished_at;
  return s;
};

interface CheckpointRow {
  id: string;
  task_run_id: string;
  step_id: string;
  reason: CheckpointReason;
  state_ref: string;
  summary: string;
  created_at: string;
}

export const rowToCheckpoint = (r: CheckpointRow): Checkpoint => ({
  id: r.id,
  taskRunId: r.task_run_id,
  stepId: r.step_id,
  reason: r.reason,
  stateRef: r.state_ref,
  summary: r.summary,
  createdAt: r.created_at,
});

interface ApprovalRow {
  id: string;
  task_run_id: string;
  checkpoint_id: string;
  action_type: ApprovalActionType;
  action_summary: string;
  status: ApprovalStatus;
  decision_message: string | null;
  decided_at: string | null;
  proposed_action_json: string | null;
}

export const rowToApproval = (r: ApprovalRow): Approval => {
  const a: Approval = {
    id: r.id,
    taskRunId: r.task_run_id,
    checkpointId: r.checkpoint_id,
    actionType: r.action_type,
    actionSummary: r.action_summary,
    status: r.status,
  };
  if (r.decision_message !== null) a.decisionMessage = r.decision_message;
  if (r.decided_at !== null) a.decidedAt = r.decided_at;
  if (r.proposed_action_json) {
    try {
      a.proposedAction = JSON.parse(r.proposed_action_json);
    } catch {
      // Drop corrupt JSON silently; runner will reject as missing details.
    }
  }
  return a;
};

interface ArtifactRow {
  id: string;
  task_run_id: string;
  step_id: string | null;
  kind: ArtifactKind;
  title: string;
  uri: string;
  summary: string | null;
  created_at: string;
}

export const rowToArtifact = (r: ArtifactRow): Artifact => {
  const a: Artifact = {
    id: r.id,
    taskRunId: r.task_run_id,
    kind: r.kind,
    title: r.title,
    uri: r.uri,
    createdAt: r.created_at,
  };
  if (r.step_id !== null) a.stepId = r.step_id;
  if (r.summary !== null) a.summary = r.summary;
  return a;
};
