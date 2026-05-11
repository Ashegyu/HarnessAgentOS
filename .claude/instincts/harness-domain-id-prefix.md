---
id: harness-domain-id-prefix
trigger: "when adding a new feature to HarnessAgentOS"
confidence: 0.95
domain: architecture
source: local-repo-analysis
---

# Register a New ID Prefix in id.ts

## Action

1. Open `packages/storage/src/id.ts`
2. Add a new prefix constant (e.g., `export const XYZ_PREFIX = "xyz_"`)
3. Use `newId("xyz")` everywhere for this entity — never `crypto.randomUUID()` or ad-hoc strings

Current registered prefixes:
- `thr_` Thread
- `tsk_` TaskRun
- `stp_` Step
- `ckp_` Checkpoint
- `apv_` Approval
- `art_` Artifact
- `qg_` QualityGateResult
- `cap_` Capability
- `lrn_` LearningTrace
- `agi_` AgentInvocation (Phase 8)

## Evidence

- All domain IDs follow this prefix convention throughout the codebase
- Consistent prefixes make it immediately obvious from a bare ID what domain object it references
