---
id: harness-ipc-checklist
trigger: "when adding a new feature to HarnessAgentOS"
confidence: 0.95
domain: architecture
source: local-repo-analysis
---

# Follow the 9-Step IPC Addition Checklist

## Action

When adding any new IPC method to HarnessAgentOS, always modify all 9 layers in order:

1. `packages/core/src/ipc-channels.ts` — add `namespace.verb`
2. `packages/core/src/ipc-channels.test.mjs` — extend the namespace assertion
3. `packages/core/src/api.ts` — add typed method to `HarnessDesktopApi`
4. Service implementation (typed errors + input validation)
5. `apps/desktop/electron/ipc/<namespace>-ipc.ts` — thin handler, validate, delegate, broadcast
6. `apps/desktop/electron/preload.ts` — wire `invokeUnwrapped`
7. UI consumer component
8. Unit test (service + IPC namespace assertion)
9. `docs/contracts/ipc-contracts.md` — describe method, error codes, transitions

State-changing handlers MUST call `events.taskRunChanged(id)` after success.

## Evidence

- All 8 existing IPC namespaces follow this exact pattern
- ipc-channels.test.mjs enforces namespace completeness at test time
- Missing any layer causes TypeScript or runtime failures
