# A2A Phase F Operational Verification Report

Date: 2026-05-15
Workspace: `C:\Users\GC\Desktop\Works\Personal\Study\HarnessAgentOS`

## Scope

This report covers the Phase F local operational smoke for the opt-in A2A companion wrapper.

Verified commits:

- `708c80c` - `feat(agent): add opt-in A2A server gateway`
- `97e3eff` - `test(agent): cover A2A companion ops wrapper`
- `9fed09f` - `feat(agent): add A2A companion ops wrapper`

## Verified Surface

- `packages/agent/src/a2a-server-gateway.ts`
- `packages/agent/src/a2a-server-companion.ts`
- `packages/agent/src/a2a-server-companion.test.mjs`

The companion wrapper is not registered in Electron main, preload, renderer, or desktop IPC. It only starts a listener when a caller explicitly invokes `createA2ACompanionServer(...).start()`.

## Companion Contract

- Default bind host: `127.0.0.1`
- Default port: `0` so tests receive an OS-assigned ephemeral port
- Agent Card route: `GET /.well-known/agent-card.json`
- JSON-RPC route: `POST /a2a/jsonrpc`
- Default body limit: 128 KiB
- Transport advertised in Agent Card: `JSONRPC`
- Supported operational smoke method: `message/send`

## Smoke Matrix

| Case | Expected | Result |
| --- | --- | --- |
| Agent Card fetch | `200`, JSON card with loopback JSON-RPC URL | Passed |
| Authenticated `message/send` | `200`, A2A task response, `completed` state | Passed |
| Missing bearer token | `401`, `A2A_SERVER_UNAUTHORIZED`, handler not invoked | Passed |
| Oversized request body | `413`, `A2A_COMPANION_BODY_TOO_LARGE`, handler not invoked | Passed |
| Gateway feature flag default | `404`, `A2A_SERVER_DISABLED` | Passed in gateway contract test |
| Workspace boundary | `403`, `A2A_SERVER_WORKSPACE_DENIED` outside allowed roots | Passed in gateway contract test |
| Rate limiting | `429`, `A2A_SERVER_RATE_LIMITED` after per-client limit | Passed in gateway contract test |

## Verification Commands

```bash
node --import tsx --test --test-force-exit packages\agent\src\a2a-server-companion.test.mjs
node --import tsx --test --test-force-exit packages\agent\src\a2a-server-gateway.test.mjs packages\agent\src\a2a-server-companion.test.mjs
npm run check
npm run test
npm run build
```

Observed results:

- Companion wrapper target test: 3 passed, 0 failed
- Gateway + companion target tests: 9 passed, 0 failed
- `npm run check`: passed
- `npm run test`: 634 passed, 0 failed
- `npm run build`: passed

## Safety Checks

- No Express dependency was added.
- No WebSocket server was added.
- No Electron main process listener was added.
- No renderer network call path was added.
- No automatic startup path was added.
- Bearer auth is checked before work is invoked.
- Body size is capped before JSON parsing.
- Workspace boundary validation remains in the gateway.
- Audit events remain in the gateway for accepted and denied work decisions.

## Remaining Operational Gaps

- Official A2A Inspector/TCK was not run in this local smoke. A compatible external tool must be installed or provided before that check can be completed.
- The companion wrapper currently covers JSON-RPC `message/send` only. Streaming, push notification, task resubscribe, cancellation, and long-lived task store behavior remain out of scope.
- Workspace boundary validation is path-string based in the gateway. Before exposing this beyond local trusted use, add a `realpath`/symlink escape check.
- TLS, OS service registration, fixed port allocation, and external network exposure are intentionally not implemented.

## Verdict

Phase F local operational smoke is passed for the opt-in loopback companion wrapper. The implementation remains local-only and not-ready for external exposure until Inspector/TCK, symlink boundary, TLS, and lifecycle checks are completed.
