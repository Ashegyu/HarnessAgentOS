---
id: harness-renderer-no-polling
trigger: "when writing HarnessAgentOS code"
confidence: 0.95
domain: architecture
source: local-repo-analysis
---

# Renderer Must Never Poll — Use Event Push Channels

## Action

The renderer (`apps/desktop/src`) MUST subscribe to push events, not poll IPC:

- **`window.harness.events.onTaskRunChanged(handler)`** — fires after any state-mutating IPC call
- **`window.harness.events.onAgentStreamEvent(handler)`** — fires per-chunk during `agent.generatePlan`

`WorkbenchShell.tsx` handles `onTaskRunChanged` and refetches state.
`AgentStreamView.tsx` handles `onAgentStreamEvent` and filters by `invocationId`.

Never add `setInterval` or `setTimeout` polling in renderer components.

Main-process side: every state-changing IPC handler MUST call
`events.taskRunChanged(taskRunId)` (and/or `events.agentStreamEvent(chunk)`)
after the mutation succeeds.

## Evidence

- `event-bus.ts` is the single broadcast mechanism in main process
- `WorkbenchShell.tsx` is the canonical subscriber example
- Polling would create race conditions with the SQLite WAL writer
