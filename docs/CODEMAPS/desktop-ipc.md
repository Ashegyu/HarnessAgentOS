# CODEMAP: Desktop IPC

A flat map of which file owns which slice of the renderer ↔ main contract.
Use this when adding/changing an IPC method so all four moving pieces stay
in sync.

## Single source of truth

| Surface | File |
|--|--|
| Channel strings | [packages/core/src/ipc-channels.ts](../../packages/core/src/ipc-channels.ts) |
| Renderer-facing types | [packages/core/src/api.ts](../../packages/core/src/api.ts) (`HarnessDesktopApi`) |
| Service types & errors | [packages/core/src/conversation/types.ts](../../packages/core/src/conversation/types.ts), [packages/core/src/error.ts](../../packages/core/src/error.ts) |
| Human-readable contract | [docs/contracts/ipc-contracts.md](../contracts/ipc-contracts.md) |

When you add a method, all five must change together. The
[ipc-channels.test.mjs](../../packages/core/src/ipc-channels.test.mjs)
namespace assertions catch drift in the first two.

## Per-namespace owners

| Namespace | IPC handler | Service / source |
|--|--|--|
| `app` | [apps/desktop/electron/ipc/app-ipc.ts](../../apps/desktop/electron/ipc/app-ipc.ts) | Electron `app`/`dialog` |
| `state` | [apps/desktop/electron/ipc/state-ipc.ts](../../apps/desktop/electron/ipc/state-ipc.ts) | `LocalStateService` (@harness/storage) |
| `conversation` | [apps/desktop/electron/ipc/conversation-ipc.ts](../../apps/desktop/electron/ipc/conversation-ipc.ts) | [packages/core/src/conversation/conversation-service.ts](../../packages/core/src/conversation/conversation-service.ts) |
| `runner` | [apps/desktop/electron/ipc/runner-ipc.ts](../../apps/desktop/electron/ipc/runner-ipc.ts) | [packages/runners/src/runner-service.ts](../../packages/runners/src/runner-service.ts) |
| `quality` | [apps/desktop/electron/ipc/quality-ipc.ts](../../apps/desktop/electron/ipc/quality-ipc.ts) | [packages/quality/src/quality-evaluator.ts](../../packages/quality/src/quality-evaluator.ts) + [packages/core/src/task-run/task-run-completion-service.ts](../../packages/core/src/task-run/task-run-completion-service.ts) |
| `capability` | [apps/desktop/electron/ipc/capability-ipc.ts](../../apps/desktop/electron/ipc/capability-ipc.ts) | [packages/skillify-adapter/src/capability-service.ts](../../packages/skillify-adapter/src/capability-service.ts) |
| `learner` | [apps/desktop/electron/ipc/learner-ipc.ts](../../apps/desktop/electron/ipc/learner-ipc.ts) | [packages/learner/src/learner-advisor.ts](../../packages/learner/src/learner-advisor.ts), [packages/learner/src/trace-recorder.ts](../../packages/learner/src/trace-recorder.ts) |
| `orchestration` | [apps/desktop/electron/ipc/orchestration-ipc.ts](../../apps/desktop/electron/ipc/orchestration-ipc.ts) | [packages/orchestration/src/orchestration-service.ts](../../packages/orchestration/src/orchestration-service.ts) (feature-flag `HARNESS_ORCHESTRATION_ENABLED=1`) |
| `agent` | [apps/desktop/electron/ipc/agent-ipc.ts](../../apps/desktop/electron/ipc/agent-ipc.ts) | [packages/agent/src/agent-planning-service.ts](../../packages/agent/src/agent-planning-service.ts) + [provider-detection.ts](../../packages/agent/src/provider-detection.ts) + [model-cli-adapter.ts](../../packages/agent/src/model-cli-adapter.ts) |
| `events` | broadcaster: [apps/desktop/electron/event-bus.ts](../../apps/desktop/electron/event-bus.ts) — subscriber: [apps/desktop/electron/preload.ts](../../apps/desktop/electron/preload.ts) | n/a (one-way main → renderer; two classes: id-only `taskRunChanged` + scoped chunk `agentStreamEvent`) |

## Wiring entry points

| Hook | File |
|--|--|
| Main process bootstrap (DB, services, BrowserWindow) | [apps/desktop/electron/main.ts](../../apps/desktop/electron/main.ts) |
| Single IPC registration entry | [apps/desktop/electron/ipc/index.ts](../../apps/desktop/electron/ipc/index.ts) (`registerAllIpc`) |
| Preload contextBridge (`window.harness`) | [apps/desktop/electron/preload.ts](../../apps/desktop/electron/preload.ts) |
| Renderer entry | [apps/desktop/src/main.tsx](../../apps/desktop/src/main.tsx) → [apps/desktop/src/screens/workbench/WorkbenchShell.tsx](../../apps/desktop/src/screens/workbench/WorkbenchShell.tsx) |

## Renderer event subscription

`WorkbenchShell` subscribes to `events:taskRunChanged` so the right panel
refetches whenever a TaskRun row mutates in the canonical store. The
broadcast is fired from each successful state-changing IPC handler — the
renderer never has to poll.

## Agent mode flow (Phase 8)

```
conversation.createTask({mode: "agent"})
  -> TaskRun status=drafting (no plan artifact, no approval)
  -> agent.generatePlan({taskRunId})
       -> [main] spawn `claude --print` or `codex exec`
       -> stream raw chunks via events:agentStreamEvent (redacted)
       -> parse fenced JSON block `harness_agent_plan`
       -> validate each proposedAction via validateProposedActionDetails
       -> create plan artifact + N approval rows
       -> TaskRun -> waiting_for_approval (or ready_for_review if 0 actions)
  -> user approves -> runner.executeApproved (existing RunnerService)
  -> quality.evaluate -> quality.markDone (LearningTrace auto-stamped)
```

`mode` is locked at TaskRun creation — to switch, create a new TaskRun.

## TaskRun state-action surface (Pause/Resume/Retry/Cancel)

| Layer | File |
|--|--|
| Service methods | `pauseTask`/`resumeTask`/`cancelTask` in [conversation-service.ts](../../packages/core/src/conversation/conversation-service.ts), `retryApproval` in [runner-service.ts](../../packages/runners/src/runner-service.ts) |
| IPC | [conversation-ipc.ts](../../apps/desktop/electron/ipc/conversation-ipc.ts), [runner-ipc.ts](../../apps/desktop/electron/ipc/runner-ipc.ts) |
| UI | [TaskRunStateActions.tsx](../../apps/desktop/src/screens/workbench/TaskRunStateActions.tsx), [CancelTaskDialog.tsx](../../apps/desktop/src/screens/workbench/CancelTaskDialog.tsx) — mounted at the top of [RightPanel.tsx](../../apps/desktop/src/screens/workbench/RightPanel.tsx) |
| Errors | `CONVERSATION_INVALID_STATE`, `CONVERSATION_NOTHING_TO_RESUME`, `CONVERSATION_REASON_REQUIRED`, `RUNNER_RETRY_NOT_BLOCKED` in [error.ts](../../packages/core/src/error.ts) |

## E2E

[apps/desktop/e2e/smoke.spec.ts](../../apps/desktop/e2e/smoke.spec.ts) launches
the built bundle against an isolated `userData` dir. Run with
`npm --workspace=@harness/desktop run e2e` (does `rebuild:electron` + `build`
first). Unit tests stay on Node ABI, so re-run `npm rebuild better-sqlite3`
or `npm run rebuild:node` before `npm test` if you've just done an Electron
rebuild on Windows.
