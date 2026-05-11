---
id: harness-agent-fake-adapter
trigger: "when writing tests for HarnessAgentOS"
confidence: 0.98
domain: testing
source: local-repo-analysis
---

# Use FakeModelCliAdapter in Agent Tests — Never Real CLIs

## Action

In any test that exercises `AgentPlanningService` or code that calls a CLI:

1. Import `FakeModelCliAdapter` from `@harness/agent`
2. Pass it as `adapter` in the service deps
3. Inject lower timeouts to prevent hangs:

```ts
const svc = new AgentPlanningService({
  state,
  getProviderStatus: () => fakeStatus,
  adapter: new FakeModelCliAdapter(cannedOutput),
  defaults: { timeoutMs: 500, stallTimeoutMs: 200 },
});
```

NEVER call real `claude --version` or `codex --version` in unit tests.

## Evidence

- Phase 8 introduced `FakeModelCliAdapter` specifically as the test double
- Real CLI calls would make tests slow, flaky, and environment-dependent
- `AgentInvocationQueue.test.mjs` and `agent-planning-service.test.mjs` follow this pattern
