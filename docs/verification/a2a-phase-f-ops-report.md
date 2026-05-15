# A2A Phase F Serverless Boundary Report

Date: 2026-05-16

## Scope

This report supersedes the earlier local loopback companion smoke. The A2A
companion listener was retired so the repository stays aligned with the core
HarnessAgentOS constraint:

- no Express server
- no localhost API server
- no WebSocket server
- no automatic inbound listener from Electron main, preload, renderer, or IPC

The remaining A2A surface is serverless from the desktop app perspective:
`packages/agent/src/a2a-server-gateway.ts` is a pure request handler used by
tests and future embedding code. It does not bind a port or start a listener.

## Removed Surface

- `packages/agent/src/a2a-server-companion.ts`
- `packages/agent/src/a2a-server-companion.test.mjs`
- `createA2ACompanionServer` export from `packages/agent/src/index.ts`

The previous companion wrapper served an Agent Card and JSON-RPC endpoint over
`127.0.0.1`. Even though it was opt-in and not registered in the desktop app,
keeping it in the package conflicted with the documented no-localhost-server
architecture, so it has been removed.

## Current Verified Surface

- `packages/agent/src/a2a-server-gateway.ts`
- `packages/agent/src/a2a-server-gateway.test.mjs`
- A2A client/worker adapter paths that call remote endpoints outbound only

## Verification Commands

```bash
node --import tsx --test --test-force-exit packages\agent\src\a2a-server-gateway.test.mjs packages\agent\src\a2a-worker-invoker.test.mjs packages\agent\src\a2a-invocation-adapter.test.mjs packages\agent\src\a2a-sdk-client.test.mjs
npm run check
npm run test
npm run build
```

## Safety Checks

- No Express dependency was added by this cleanup.
- No WebSocket server is present.
- No Electron main process listener is registered.
- No renderer network call path was added.
- No automatic startup path exists.
- Gateway bearer auth, rate limiting, workspace boundary checks, realpath-backed
  boundary checks, and audit events remain in the pure gateway tests.

## Remaining Operational Gaps

- Official A2A Inspector/TCK is still not part of this workspace.
- Inbound A2A serving is out of scope for the current desktop MVP. If it is
  needed later, it must be designed as a separate, explicitly approved phase
  with an updated architecture decision.

## Verdict

The A2A Phase F exception is closed by removing the loopback companion listener.
HarnessAgentOS remains a serverless Electron IPC workbench at runtime.
