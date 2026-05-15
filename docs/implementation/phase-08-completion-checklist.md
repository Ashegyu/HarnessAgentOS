# Phase 08 Completion Checklist

## Scope

Phase 8 is treated as a close-out pass over the existing Agent CLI integration, not a new dependency rollout. The completed contract is:

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

No new model SDK, frontend state library, server, WebSocket, or external agent runtime was added.

## Procedural Status

| Step | Status | Evidence |
|---|---|---|
| 8.0 implementation audit | Done | Phase 8 docs, IPC contract, `packages/agent`, Electron IPC, preload, renderer Agent UI, and smoke scripts reviewed. |
| 8.1 IPC/type contract | Done | `packages/core/src/ipc-channels.test.mjs` and `apps/desktop/electron/ipc/agent-ipc.test.mjs` pass. |
| 8.2 agent TaskRun flow | Done | `agent-planning-service.test.mjs` and fake smoke cover agent mode, answer-only, invalid output, fallback, cancel. |
| 8.3 CLI adapter safety | Done | `model-cli-adapter.test.mjs`, provider detection, queue cancellation, timeout/error mapping tests pass. |
| 8.4 output parser safety | Done | `agent-output-parser.test.mjs` and fake smoke cover malformed JSON and path traversal rejection before approval execution. |
| 8.5 UI integration | Done | Agent stream parser, grouping, display, visibility, progress, and chat status tests pass. |
| 8.6 fake smoke | Done | `smoke:agent-fake` now verifies approval does not mutate files, approved runner execution writes the file, quality gate runs, known risk is approved when needed, `markDone` succeeds, and `LearningTrace` is recorded. |
| 8.7 live smoke | Done with provider note | Codex live smoke passed. Claude was detected but timed out in the 45s constrained smoke run, so Codex is the verified live provider for this pass. |
| 8.8 Phase 7 boundary | Done | Orchestration service, worker runner, and pipeline form focused tests pass; Phase 8 did not rewrite Phase 7 orchestration. |

## Verification Commands

```powershell
node --import tsx --test --test-force-exit packages/core/src/ipc-channels.test.mjs apps/desktop/electron/ipc/agent-ipc.test.mjs packages/agent/src/provider-detection.test.mjs packages/agent/src/agent-planning-service.test.mjs packages/agent/src/model-cli-adapter.test.mjs packages/agent/src/agent-output-parser.test.mjs packages/agent/src/agent-invocation-queue.test.mjs
node --import tsx --test --test-force-exit apps/desktop/src/screens/workbench/agent-stream-parser.test.mjs apps/desktop/src/screens/workbench/agent-stream-section-groups.test.mjs apps/desktop/src/screens/workbench/AgentProgressList.test.mjs apps/desktop/src/screens/workbench/agent-panel-visibility.test.mjs apps/desktop/src/screens/workbench/agent-invocation-display.test.mjs apps/desktop/src/screens/workbench/chat-turn-status.test.mjs
node --import tsx --test --test-force-exit packages/orchestration/src/orchestration-service.test.mjs packages/orchestration/src/worker-runner.test.mjs apps/desktop/src/screens/workbench/pipeline-form.test.mjs
npm --workspace=@harness/desktop run smoke:agent-fake
$env:HARNESS_SMOKE_TIMEOUT_MS='60000'; $env:HARNESS_SMOKE_PROVIDER='codex'; npm --workspace=@harness/desktop run smoke:agent-live
```

Final close-out should still run the repository-wide commands:

```powershell
npm run check
npm run test
$env:CSC_IDENTITY_AUTO_DISCOVERY='false'; npm run build
git diff --check
```

## Operational Notes

- If `better-sqlite3` reports a Node ABI mismatch, close the running Electron app and run `npm run rebuild:node` before smoke scripts.
- Live smoke may use network/authenticated CLI state. A missing or timing-out provider should not block Template mode or fake smoke.
- `conversation.createTask({ mode: "agent" })` intentionally creates a placeholder plan artifact and checkpoint, but no placeholder approval. Real approvals are created only by `agent.generatePlan()`.
