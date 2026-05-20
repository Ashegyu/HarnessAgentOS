# A2A Refinement Backflow Plan

Date: 2026-05-20
Status: R1-R5 Implemented

## 1. Purpose

This document designs the "send corrections back to a previous agent" capability
for HarnessAgentOS A2A workers.

The feature should not be treated as machine-learning backpropagation. In A2A
terms, it is a client-owned refinement flow:

- a downstream worker, quality gate, or user finds a problem
- Harness identifies the earlier remote A2A invocation that produced the
  disputed output
- Harness sends a bounded follow-up/refinement message to that same remote
  endpoint, with references to the prior remote task and local artifacts
- the remote agent returns a new task/message/artifact
- Harness stores the new result as a separate attempt and keeps all side effects
  behind the existing approval model

The design must preserve the current project constraints:

- no Express, localhost, WebSocket, or inbound listener
- no renderer direct A2A SDK access
- SQLite WAL remains canonical state
- remote agents never execute local file/shell/git/dependency/network actions
  directly
- every local side effect remains approval-gated
- feedback loops must have hard stop conditions

## 2. Current Evidence

Observed implementation surfaces:

- `packages/core/src/types/a2a.ts` stores `A2ARemoteTaskRef` with
  `remoteTaskId`, `remoteContextId`, and state.
- `packages/agent/src/a2a-invocation-adapter.ts` accepts only
  `invocationId`, `taskRunId`, `endpointId`, and `message` in
  `A2AInvocationRequest`.
- `packages/agent/src/a2a-sdk-client.ts` sends a new user message but does not
  include `contextId`, `taskId`, or `referenceTaskIds`.
- `packages/orchestration/src/worker-runner.ts` passes successful upstream
  worker output only to downstream dependencies through internal handoff
  messages.
- `packages/orchestration/src/orchestration-policy.ts` rejects dependency
  cycles before execution.
- `packages/quality/src/repair-loop-service.ts` has a bounded repair loop with
  default max attempts and repeated failure signature blocking.

Inference:

- The repository already persists enough remote task identity to support
  refinement later, but the outbound A2A request contract does not yet expose
  that identity.
- The existing repair loop has the right loop-guard pattern, but it is not
  directed at the original A2A worker that produced a disputed artifact.

Uncertainty:

- Some remote A2A servers may ignore `referenceTaskIds` or reject client-supplied
  `contextId`; the implementation must treat this as a capability/compatibility
  concern rather than assuming all endpoints support refinement.

## 3. Scope

### Included

- Directed refinement from a later finding back to a previous A2A invocation.
- User-triggered refinement from the Agent/Quality UI.
- Quality-gate-triggered refinement proposal.
- Downstream reviewer/tester worker output converted into a refinement
  proposal.
- SQLite ledger for attempts, loop guards, and auditability.
- A2A request contract extension behind `A2AClientPort`.
- Operator-visible history of refinement attempts.

### Excluded

- Automatic unbounded agent-to-agent recursion.
- Mutating or restarting a terminal A2A task.
- Inbound webhook/push server.
- Remote agent direct access to local workspace side effects.
- Replacing `RepairLoopService`.
- Treating remote refinement success as `TaskRun.done`.

## 4. Terminology

| Term | Meaning |
|---|---|
| Backflow | Harness-controlled feedback routed from a later finding to an earlier worker. |
| Refinement | A new A2A message/task that asks a remote agent to revise or clarify a prior result. |
| Target invocation | The earlier `AgentInvocation` whose output is being corrected. |
| Feedback source | User, quality gate, reviewer worker, tester worker, or another recorded artifact. |
| Refinement edge | Directed relation from feedback source to target invocation. |
| Attempt | One concrete remote A2A refinement request and its result. |
| Failure signature | Stable hash of feedback content, target invocation, referenced artifacts, and gate evidence. |

## 5. Design Decision

Implement backflow as a separate refinement ledger and invocation mode, not as
runtime graph reversal.

The worker dependency graph remains acyclic and forward-executed. A refinement
does not insert a backward edge into `WorkerStep.dependsOn`. Instead, it creates a
new attempt that references:

- the target invocation
- the target remote task/context when available
- the feedback artifact or quality gate evidence
- the source worker step/invocation when applicable

This preserves the current topology rules while allowing a previous remote agent
to produce a revised answer.

## 6. State Model

### 6.1 Core Types

```ts
export type A2ARefinementStatus =
  | "pending_approval"
  | "queued"
  | "running"
  | "input_required"
  | "auth_required"
  | "succeeded"
  | "failed"
  | "stopped"
  | "cancelled";

export interface A2ARefinementTarget {
  invocationId: string;
  endpointId: string;
  remoteTaskId?: string;
  remoteContextId?: string;
  artifactIds: readonly string[];
}

export interface A2ARefinementRequest {
  taskRunId: string;
  targetInvocationId: string;
  feedbackSourceKind: "user" | "quality_gate" | "worker" | "system";
  feedbackSourceStepId?: string;
  feedbackSourceInvocationId?: string;
  feedbackArtifactId?: string;
  qualityGateId?: string;
  instruction: string;
  referencedArtifactIds: readonly string[];
}

export interface A2ARefinementAttempt {
  id: string;
  taskRunId: string;
  targetInvocationId: string;
  endpointId: string;
  feedbackSourceKind: "user" | "quality_gate" | "worker" | "system";
  feedbackSourceStepId?: string;
  feedbackSourceInvocationId?: string;
  feedbackArtifactId?: string;
  qualityGateId?: string;
  parentRemoteTaskId?: string;
  parentRemoteContextId?: string;
  remoteTaskId?: string;
  remoteContextId?: string;
  referenceTaskIds: readonly string[];
  referenceArtifactIds: readonly string[];
  feedbackSignature: string;
  attemptIndex: number;
  status: A2ARefinementStatus;
  stopReason?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}
```

### 6.2 Storage Schema

```sql
CREATE TABLE IF NOT EXISTS a2a_refinement_attempts (
  id TEXT PRIMARY KEY,
  task_run_id TEXT NOT NULL REFERENCES task_runs(id) ON DELETE CASCADE,
  target_invocation_id TEXT NOT NULL REFERENCES agent_invocations(id) ON DELETE CASCADE,
  endpoint_id TEXT NOT NULL REFERENCES a2a_endpoints(id) ON DELETE CASCADE,
  feedback_source_kind TEXT NOT NULL CHECK(feedback_source_kind IN ('user','quality_gate','worker','system')),
  feedback_source_step_id TEXT REFERENCES steps(id) ON DELETE SET NULL,
  feedback_source_invocation_id TEXT REFERENCES agent_invocations(id) ON DELETE SET NULL,
  feedback_artifact_id TEXT REFERENCES artifacts(id) ON DELETE SET NULL,
  quality_gate_id TEXT REFERENCES quality_gate_results(id) ON DELETE SET NULL,
  parent_remote_task_id TEXT,
  parent_remote_context_id TEXT,
  remote_task_id TEXT,
  remote_context_id TEXT,
  reference_task_ids_json TEXT NOT NULL,
  reference_artifact_ids_json TEXT NOT NULL,
  feedback_signature TEXT NOT NULL,
  attempt_index INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN (
    'pending_approval',
    'queued',
    'running',
    'input_required',
    'auth_required',
    'succeeded',
    'failed',
    'stopped',
    'cancelled'
  )),
  stop_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_a2a_refinement_attempts_task_run
  ON a2a_refinement_attempts(task_run_id, created_at);

CREATE INDEX IF NOT EXISTS idx_a2a_refinement_attempts_target
  ON a2a_refinement_attempts(target_invocation_id, attempt_index);

CREATE INDEX IF NOT EXISTS idx_a2a_refinement_attempts_signature
  ON a2a_refinement_attempts(task_run_id, target_invocation_id, feedback_signature);

CREATE UNIQUE INDEX IF NOT EXISTS idx_a2a_refinement_attempts_active_signature
  ON a2a_refinement_attempts(task_run_id, target_invocation_id, feedback_signature)
  WHERE status IN ('pending_approval','queued','running','input_required','auth_required');
```

The table is a ledger. Attempts are appended and updated to terminal state; they
are not reused for another refinement.

## 7. A2A Request Contract

Extend the SDK-independent request type first:

```ts
export interface A2AInvocationRequest {
  invocationId: string;
  taskRunId: string;
  endpointId: string;
  message: string;
  contextId?: string;
  taskId?: string;
  referenceTaskIds?: readonly string[];
  metadata?: Record<string, unknown>;
}
```

Mapping rules:

- `input-required` continuation may include `taskId` and `contextId`.
- Refinement of a completed/failed/rejected/canceled task should not restart the
  terminal task. It should send a new message in the same `contextId` when the
  endpoint supports it, with the prior task in `referenceTaskIds`.
- If the endpoint rejects supplied `contextId`, Harness records the attempt as
  `stopped` with a compatibility stop reason and falls back only if the user
  explicitly asks for a new-context retry.
- Artifact references stay in `metadata` and prompt text until a specific A2A
  artifact reference convention is validated against the SDK.

## 8. Execution Flow

### 8.1 User-Triggered Refinement

```text
User clicks "Request refinement" on a remote invocation
  -> UI collects correction instruction and selected artifacts
  -> Main validates target invocation and remote task ref
  -> Refinement policy checks attempt limits and repeated signature
  -> Create A2ARefinementAttempt(status = pending_approval)
  -> Create network Approval whose checkpoint stateRef includes the attempt id
  -> After approval, mark attempt queued/running
  -> Invoke remote endpoint with context/reference hints
  -> Store new AgentInvocation, remote task ref, raw output artifact
  -> Mark attempt succeeded/failed/stopped
  -> Surface revised output as pending approval or ready_for_review evidence
```

### 8.2 Downstream Worker Feedback

```text
Reviewer/tester worker produces finding artifact
  -> Worker output remains forward-only
  -> Harness derives a refinement proposal targeting the earlier remote invocation
  -> User approves the proposal
  -> Refinement attempt runs as a new A2A invocation
```

The downstream worker must not directly call the previous agent. It can only
produce a refinement proposal that the operator approves.

### 8.3 Quality-Gate Feedback

```text
Quality gate fails
  -> RepairLoopService still owns normal repair plan generation
  -> If failed evidence maps to a remote A2A invocation, offer targeted A2A refinement
  -> Refinement attempt counts against A2A refinement limits
  -> Existing repair loop attempt limits remain independent but visible together
```

The first implementation should keep `RepairLoopService` unchanged and add the
targeted A2A refinement as an optional path beside it.

### 8.4 Input Required

`input-required` is not a backflow. It is continuation of the current remote task.

For `input-required`, Harness should use the existing `remoteTaskId` and
`remoteContextId` to continue the same interrupted task, not create a refinement
attempt against a terminal result.

## 9. Loop Guard Policy

Hard limits:

- max 2 refinement attempts per `(taskRunId, targetInvocationId, feedbackSignature)`
- max 4 refinement attempts per `taskRunId`
- max 1 automatic refinement proposal per failed quality gate
- max 1 active attempt for the same `(taskRunId, targetInvocationId,
  feedbackSignature)`
- no automatic refinement after a refinement attempt returns the same failure
  signature
- no automatic refinement when the target remote endpoint is disabled, untrusted,
  or missing

Stop reasons:

- `max_attempts_for_signature`
- `max_attempts_for_task_run`
- `repeated_feedback_signature`
- `endpoint_unavailable`
- `context_rejected_by_endpoint`
- `missing_remote_task_ref`
- `user_cancelled`
- `auth_required`
- `input_required`

Implementation rule:

- A stopped attempt is terminal.
- A new attempt must compute a new signature before invoking the remote endpoint.
- Attempt creation and active-attempt checks must happen in one SQLite
  transaction so a double-click or duplicate event cannot enqueue two identical
  remote calls.
- The signature must include target invocation id, feedback source id, referenced
  artifact ids, normalized instruction text, and quality gate evidence ids.

## 10. Approval and Security Policy

Refinement sends a network request to an already trusted remote endpoint. The
minimum safe policy is:

- Phase R1 uses the existing `network` approval action type instead of adding a
  new public `ApprovalActionType`.
- every refinement creates a pending approval with the exact endpoint, target
  invocation, attempt id, and message preview
- quality/worker-triggered refinement always requires approval
- remote proposed actions still pass through `validateProposedActionDetails`
  and worker allowed action policy
- remote artifact payload must not be promoted to side effects
- secrets are redacted before storing prompt, status messages, and artifacts
- renderer sees only `window.harness.*` data, not SDK objects

## 11. UI and Operator Visibility

Add visibility in existing workbench surfaces:

- Agent tab: show refinement attempts under the target invocation
- Quality tab: show "Targeted A2A refinement available" when evidence maps to a
  remote invocation
- Approval panel: show endpoint, original remote task id, context id, referenced
  artifacts, and loop guard count
- Activity log: record attempt created, started, stopped, succeeded, failed

The UI must make clear that revised remote output is new evidence, not automatic
completion.

## 12. Minimal Implementation Plan

### Phase R1: Ledger and Policy

1. Add core refinement types and validators.
2. Add `a2a_refinement_attempts` migration and repository.
3. Add a pure policy helper for attempt limits and feedback signature hashing.
4. Add active-attempt transaction handling to prevent duplicate in-flight
   refinements.
5. Add repository tests and policy tests.

### Phase R2: Request Contract

1. Extend `A2AInvocationRequest` behind `A2AClientPort`.
2. Update `OfficialA2AClientPort` to map `contextId`, `taskId`, and
   `referenceTaskIds` into the SDK message object.
3. Add tests proving SDK types still do not leak into `packages/core`,
   renderer, or storage.

### Phase R3: Invocation Service

1. Add `A2ARefinementService` in `packages/agent` or Electron main composition.
2. Create a new `AgentInvocation` for each refinement attempt.
3. Persist prompt/raw output artifacts and remote task refs.
4. Update the refinement attempt terminal status.

### Phase R4: UI and IPC

1. Add a narrow `agent.requestRefinement` IPC surface.
2. Expose attempts through `TaskRunDetail`.
3. Add Agent tab and Approval panel rendering.
4. Keep renderer free of direct network calls.
5. Execute only refinement-tagged `network` approvals through a dedicated
   main-process executor; the generic runner still blocks ordinary network
   approvals.

### Phase R5: Quality and Worker Integration

1. Add optional targeted refinement proposal generation from reviewer/tester
   findings.
2. Add optional targeted refinement proposal from failed quality gate evidence.
3. Do not replace the existing repair loop.
4. Expose proposals as read-only `TaskRunDetail.a2aRefinementProposals`; creating
   one still uses `agent.requestRefinement` and creates a pending `network`
   approval.
5. Render refinement approvals with endpoint, parent remote task/context, target
   invocation, referenced artifacts, and loop guard counts.
6. Record dedicated A2A refinement activity events for created, started, and
   terminal attempt states.

## 13. Verification Plan

Unit tests:

- feedback signature normalization
- max attempts per signature and task run
- repeated signature stop
- request mapping for `contextId`, `taskId`, and `referenceTaskIds`
- input-required continuation stays separate from refinement

Repository tests:

- migration idempotency
- attempt create/update/list by task run
- indexes and cascade behavior
- duplicate active attempt rejection under one transaction
- malformed JSON rejection for `_json` fields

Integration tests:

- fake A2A client receives context/reference fields
- refinement attempt creates a new `AgentInvocation`
- remote proposed file write becomes pending approval only
- terminal remote task is not restarted
- disabled/untrusted endpoint stops before network invocation

UI tests:

- target invocation shows attempt history
- approval card shows loop guard count and message preview
- quality panel shows targeted refinement option only when evidence maps to a
  remote invocation

Operational smoke:

- run against a compatible A2A endpoint that supports context continuation
- run against an endpoint that rejects client-supplied context
- confirm both paths leave canonical state in SQLite and no local side effect is
  executed without approval

## 14. Recommended Decisions After Review

1. Renderer-facing API: use `agent.requestRefinement`, because the action is
   anchored to an `AgentInvocation`. Keep `remoteAgents.*` limited to endpoint
   registry/card concerns.
2. Approval model: create a formal `network` approval for every refinement in
   Phase R1. The explicit button click is not enough because the request sends
   task context and artifacts to a remote endpoint.
3. Scope: R1 targets remote A2A invocations only. Local CLI worker backflow can
   reuse the same vocabulary later, but should not be mixed into the first
   migration.
4. Evidence mapping: start with explicit target metadata from reviewer/tester
   output or UI selection. Rule-based mapping from arbitrary quality evidence is
   a later convenience layer, not the first correctness path.

## 15. Performance and Latency Notes

This is a cold operator-controlled path, not a render or runner hot path.
Still, implementation should avoid accidental cost:

- policy checks should use indexed SQLite reads by `task_run_id`,
  `target_invocation_id`, and `feedback_signature`
- feedback signature hashing should use bounded normalized text and artifact ids,
  not full artifact bodies by default
- full artifact bodies should be loaded only when building the approved remote
  message
- UI should render attempt summaries and lazy-expand raw output artifacts
- no polling loop should be added for refinement; reuse existing task/run change
  push events and explicit refresh paths

## 16. Design Review and Corrections

Review pass: 2026-05-20.

Findings and applied corrections:

1. The initial flow created approval before the attempt row. That made approval
   UI/audit linking weaker. The design now creates a `pending_approval` attempt
   first and stores the attempt id in the approval checkpoint state.
2. The initial schema lacked an active duplicate guard. The design now includes a
   partial unique index and requires transactional creation.
3. Endpoint delete behavior was not aligned with existing `a2a_remote_tasks`.
   The schema now uses `ON DELETE CASCADE` for `endpoint_id`.
4. The initial design left the IPC namespace, approval model, and first-phase
   local-vs-remote scope as open questions. The reviewed design now records
   recommended decisions for all three.
5. The initial design did not call out performance boundaries. The reviewed
   design now documents indexed policy reads, bounded hashing, lazy artifact
   loading, and no new polling loop.
6. Implementation review found that approval creation alone was not enough:
   the full refinement instruction must survive until approval execution, and
   `runner.executeApproved` needs a narrow A2A refinement override. The
   implemented flow now stores the instruction in the approval checkpoint
   `stateRef` and runs only approvals containing an `a2aRefinementAttemptId`;
   all other `network` approvals remain blocked by the generic runner.
7. R5 implementation review kept proposal generation read-only. Worker findings
   only produce proposals when a reviewer/tester-style worker directly depends
   on a remote A2A worker, and quality gates only produce proposals when failed
   evidence maps directly to a remote A2A invocation. The user must still create
   the refinement approval explicitly.
8. R5 UI completion added a dedicated approval-card section for refinement
   approvals and a separate `a2a_refinement_events` activity ledger. Activity
   rows are audit records only; they do not trigger retries or remote calls.

## 17. References

- `docs/architecture/a2a-integration-plan.md`
- `docs/architecture/internal-agent-message-bus-plan.md`
- `packages/core/src/types/a2a.ts`
- `packages/agent/src/a2a-invocation-adapter.ts`
- `packages/agent/src/a2a-sdk-client.ts`
- `packages/orchestration/src/worker-runner.ts`
- `packages/quality/src/repair-loop-service.ts`
- A2A specification: `Message.contextId`, `Message.taskId`, and
  `Message.referenceTaskIds`
- A2A Life of a Task: refinements are new interactions in the same context, not
  restarted terminal tasks
