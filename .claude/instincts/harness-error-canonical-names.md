---
id: harness-error-canonical-names
trigger: "when writing HarnessAgentOS code"
confidence: 0.92
domain: code-quality
source: local-repo-analysis
---

# Use Canonical Long-Form Error Constants, Not Deprecated Aliases

## Action

Always use the canonical long-form constant names. Upgrade deprecated aliases when you touch a file.

| Use this (canonical) | Not this (deprecated) |
|--|--|
| `CAPABILITY_UNTRUSTED_SKILL` | `CAPABILITY_UNTRUSTED_SCRIPT` |
| `LEARNER_INVALID_DECISION` | `LEARNER_DECISION_INVALID` |
| `ORCHESTRATION_TASK_NOT_FOUND` | `ORCH_TASK_NOT_FOUND` |
| `ORCHESTRATION_INVALID_PLAN` | `ORCH_INVALID_PLAN` |
| `ORCHESTRATION_APPROVAL_REQUIRED` | `ORCH_APPROVAL_NOT_APPROVED` |

Phase 8 agent codes (use directly, no aliases exist):
- `AGENT_PROVIDER_UNAVAILABLE`
- `AGENT_TASK_RUN_NOT_FOUND`
- `AGENT_INVOCATION_NOT_FOUND`
- `AGENT_INVOCATION_BUSY`
- `AGENT_MODE_MISMATCH`
- `AGENT_PROPOSED_ACTION_INVALID`

## Evidence

- Phase 8 renamed error constants to match `docs/contracts/ipc-contracts.md`
- Deprecated aliases are marked `@deprecated` in `packages/core/src/error.ts`
- The aliases will be removed in a future release
