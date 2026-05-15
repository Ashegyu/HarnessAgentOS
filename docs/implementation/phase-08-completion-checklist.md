# Phase 08 Completion Checklist

## Scope

Phase 8 is treated as a close-out pass over the existing Agent CLI integration,
not a new dependency rollout. The completed contract is:

```text
conversation.createTask({ mode: "agent" })
  -> agent.generatePlan()
  -> AgentInvocation + prompt/raw/parsed artifacts
  -> 0..N approval rows
  -> approved actions only run through RunnerService
  -> quality.evaluate
  -> markDone
  -> LearningTrace outcome
```

No new model SDK, frontend state library, server, WebSocket, or external agent
runtime is part of the Phase 8 desktop path. A2A work that followed Phase 8 is
kept behind the same approval/artifact/orchestration boundaries:

- remote A2A calls are outbound-only from Electron main process code
- renderer receives only `window.harness.*` IPC data
- remote worker output becomes artifacts/proposed approvals, not direct side effects
- no Express, localhost API server, WebSocket server, or inbound listener is added

## Current Close-Out Snapshot

Date: 2026-05-16

| Area | Status | Evidence |
|---|---|---|
| Agent CLI planning contract | Done | `packages/agent/src/agent-planning-service.test.mjs`, `agent-output-parser.test.mjs`, `model-cli-adapter.test.mjs`, `agent-invocation-queue.test.mjs`. |
| IPC surface contract | Done | `packages/core/src/ipc-channels.test.mjs` plus `packages/core/src/ipc-contracts-surface.test.mjs` keep `docs/contracts/ipc-contracts.md` aligned with `IPC_CHANNELS`. |
| Provider probe and queueing | Done | `provider-detection.test.mjs` and `agent-invocation-queue.test.mjs`; queue depth is surfaced through provider probe status. |
| Stream UI finalization | Done | `agent-stream-parser.test.mjs`, `AgentProgressList.test.mjs`, `agent-stream-section-groups.test.mjs`, `agent-invocation-display.test.mjs`, `chat-turn-status.test.mjs`. Parser keeps `assistant_text` provisional until terminal `result` promotion. |
| Approval and policy boundary | Done | `approval-policy.test.mjs`, `auto-approve-policy.test.mjs`, `approval-repository.test.mjs`, `runner-service.test.mjs`, `orchestration-service.test.mjs`. Blocked `policyEvaluation` cannot be executed by runner/orchestration. |
| Desktop launch smoke | Done | `npm --workspace=@harness/desktop run e2e` launches the built Electron bundle with isolated `userData` and verifies the first visible workbench flow through thread creation. |
| Service-level end-to-end smoke | Done | `npm --workspace=@harness/desktop run smoke:e2e` covers thread creation, agent TaskRun creation, provider-failure recovery, template fallback, approved runner execution, artifact reading, and final TaskRun snapshot without launching Electron. |
| Fake end-to-end smoke | Done | `npm --workspace=@harness/desktop run smoke:agent-fake` covers no side effect before approval, approved runner execution, quality gate, known-risk approval when required, `markDone`, and `LearningTrace`. |
| Live CLI smoke | Environment-dependent | `npm --workspace=@harness/desktop run smoke:agent-live` remains the manual/local CLI validation path. A missing, unauthenticated, rate-limited, or timing-out provider does not block Template mode or fake smoke. |
| Phase 7 orchestration boundary | Done | `orchestration-planner.test.mjs`, `orchestration-service.test.mjs`, `worker-runner.test.mjs`, and `pipeline-form.test.mjs` cover pipeline expansion and approval-gated worker execution. |
| A2A worker follow-up boundary | Done | `a2a-invocation-adapter.test.mjs`, `a2a-sdk-client.test.mjs`, `a2a-worker-invoker.test.mjs`, `a2a-worker-integration.test.mjs`, `agent-remote-task.test.mjs`. Remote worker lifecycle states are visible but still approval-gated. |
| A2A serverless boundary | Done | `a2a-server-gateway.test.mjs` plus `docs/verification/a2a-phase-f-ops-report.md`. The loopback companion listener/export was removed; only the pure request handler contract remains. |

## Procedural Status

| Step | Status | Evidence |
|---|---|---|
| 8.0 implementation audit | Done | Phase 8 docs, IPC contract, `packages/agent`, Electron IPC, preload, renderer Agent UI, and smoke scripts reviewed. |
| 8.1 IPC/type contract | Done | IPC channels, contract-surface, agent IPC, preload, and renderer `window.harness` types are aligned. |
| 8.2 agent TaskRun flow | Done | Agent mode creates no placeholder approval; `agent.generatePlan` creates parsed artifacts and 0..N approvals. Answer-only responses move to `ready_for_review`. |
| 8.3 CLI adapter safety | Done | Provider detection, queue cancellation, timeout/stall/error mapping, stream event normalization, and redaction tests pass. |
| 8.4 output parser safety | Done | `harness_agent_plan` parsing, malformed JSON handling, schema validation, traversal rejection, and invalid-action filtering are covered. |
| 8.5 UI integration | Done | Stream parser, progress grouping, invocation display, active task status override, final-result promotion, and remote task attention helpers are covered. |
| 8.6 desktop/service smoke | Done | Electron launch smoke and service-level E2E smoke cover the visible workbench start path plus the deeper approval/runner/artifact path. |
| 8.7 fake smoke | Done | Fake smoke validates the approval-to-runner-to-quality-to-learning path without a real CLI provider. |
| 8.8 live smoke | Manual | Use the live smoke script only on machines with an authenticated CLI provider. Do not make it a mandatory automated gate. |
| 8.9 Phase 7 boundary | Done | Orchestration/pipeline tests cover plan approval, worker execution, downstream approvals, and remote endpoint routing without bypassing approval policy. |
| 8.10 post-Phase 8 serverless boundary | Done | A2A follow-up is outbound/client-side from the desktop perspective; inbound serving remains out of scope. |

## Verification Commands

Focused Phase 8 contract:

```powershell
node --import tsx --test --test-force-exit packages/core/src/ipc-channels.test.mjs packages/core/src/ipc-contracts-surface.test.mjs apps/desktop/electron/ipc/agent-ipc.test.mjs packages/agent/src/provider-detection.test.mjs packages/agent/src/agent-planning-service.test.mjs packages/agent/src/model-cli-adapter.test.mjs packages/agent/src/agent-output-parser.test.mjs packages/agent/src/agent-invocation-queue.test.mjs
node --import tsx --test --test-force-exit apps/desktop/src/screens/workbench/agent-stream-parser.test.mjs apps/desktop/src/screens/workbench/agent-stream-section-groups.test.mjs apps/desktop/src/screens/workbench/AgentProgressList.test.mjs apps/desktop/src/screens/workbench/agent-panel-visibility.test.mjs apps/desktop/src/screens/workbench/agent-invocation-display.test.mjs apps/desktop/src/screens/workbench/chat-turn-status.test.mjs apps/desktop/src/screens/workbench/agent-remote-task.test.mjs
node --import tsx --test --test-force-exit packages/core/src/conversation/approval-policy.test.mjs packages/core/src/conversation/auto-approve-policy.test.mjs packages/storage/src/repositories/approval-repository.test.mjs packages/storage/src/services/local-state-service.test.mjs packages/runners/src/runner-service.test.mjs
```

Orchestration and A2A follow-up boundaries:

```powershell
node --import tsx --test --test-force-exit packages/orchestration/src/orchestration-planner.test.mjs packages/orchestration/src/orchestration-service.test.mjs packages/orchestration/src/worker-runner.test.mjs apps/desktop/src/screens/workbench/pipeline-form.test.mjs apps/desktop/electron/a2a-worker-integration.test.mjs
node --import tsx --test --test-force-exit packages/agent/src/a2a-invocation-adapter.test.mjs packages/agent/src/a2a-sdk-client.test.mjs packages/agent/src/a2a-worker-invoker.test.mjs packages/agent/src/a2a-server-gateway.test.mjs
```

Smoke:

```powershell
npm --workspace=@harness/desktop run e2e
npm --workspace=@harness/desktop run smoke:e2e
npm --workspace=@harness/desktop run smoke:agent-fake
$env:HARNESS_SMOKE_TIMEOUT_MS='60000'; $env:HARNESS_SMOKE_PROVIDER='codex'; npm --workspace=@harness/desktop run smoke:agent-live
```

Repository-wide close-out:

```powershell
npm run check
npm run test
$env:CSC_IDENTITY_AUTO_DISCOVERY='false'; npm run build
git diff --check
```

## Operational Notes

- If `better-sqlite3` reports a Node ABI mismatch, close the running Electron
  app and run `npm run rebuild:node`. The package smoke scripts already do
  this before opening SQLite; this note mainly applies to ad-hoc Node commands.
- Live smoke may use network/authenticated CLI state. A missing or timing-out
  provider should not block Template mode, fake smoke, or repository-wide tests.
- `conversation.createTask({ mode: "agent" })` intentionally creates a
  placeholder plan artifact and checkpoint, but no placeholder approval. Real
  approvals are created only by `agent.generatePlan()`.
- `policyEvaluation` is attached at approval creation when callers do not
  provide one. `decision="blocked"` is a hard stop for runner and orchestration
  execution even if an approval row is later marked approved.
- A2A remote worker outputs are treated like agent outputs: lifecycle/progress
  can be displayed, but side effects still require Harness approvals and runner
  execution.
