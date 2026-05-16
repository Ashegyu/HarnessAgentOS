# A2A Live Smoke Runbook

Phase 13 keeps HarnessAgentOS outbound-only. Do not add an Express,
localhost, WebSocket, FastAPI, or other listener to satisfy A2A Inspector or
TCK. Inspector/TCK must target an external A2A-compatible server.

## Optional Harness Smoke

The live smoke is skipped unless `HARNESS_A2A_REMOTE_URL` is set:

```powershell
$env:HARNESS_A2A_REMOTE_URL = "https://example.invalid/a2a"
$env:HARNESS_A2A_BEARER_TOKEN = "<optional bearer token>"
$env:HARNESS_A2A_SMOKE_TIMEOUT_MS = "30000"
npm --workspace=@harness/desktop run smoke:a2a-remote-live
```

Optional cancellation probe:

```powershell
$env:HARNESS_A2A_SMOKE_CANCEL_AFTER_MS = "1000"
npm --workspace=@harness/desktop run smoke:a2a-remote-live
```

The script opens a temporary SQLite database, registers the remote endpoint,
refreshes the Agent Card snapshot when available, invokes the remote endpoint
through the existing outbound A2A client path, records a remote task ref, and
persists smoke artifacts. It does not start a Harness server.

## Inspector/TCK Policy

1. Start or obtain an external A2A-compatible server.
2. Run A2A Inspector or TCK against that external server.
3. Register the same server as a Harness remote endpoint.
4. Run `smoke:a2a-remote-live`.
5. Compare task state mapping, artifact output, and cancellation behavior.

Harness's pure A2A gateway handler may be covered by contract tests, but that
does not make the desktop app an inbound A2A server.
