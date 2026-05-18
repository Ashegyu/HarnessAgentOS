import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isWorkerFileActionApproval,
  shouldAutoApprove,
  workerActionCheckpointSummary,
} from "./auto-approve-policy.ts";

const makeApproval = (actionType) => ({
  id: "apv_1",
  taskRunId: "tsk_1",
  checkpointId: "ckp_1",
  actionType,
  actionSummary: "s",
  status: "pending",
});

const assertDecision = (decision, approved, decidedAt) => {
  assert.equal(decision.approved, approved);
  assert.equal(decision.decidedAt, decidedAt);
  assert.equal(typeof decision.reason, "string");
  assert.ok(decision.reason.length > 0);
};

test("shouldAutoApprove returns true when global autoApprove is on and no profile override", () => {
  const r = shouldAutoApprove({
    approval: makeApproval("file_write"),
    globalAutoApprove: true,
    activeProfile: null,
  });
  assertDecision(r, true, "global_toggle");
});

test("shouldAutoApprove returns false when global autoApprove is off and no profile override", () => {
  const r = shouldAutoApprove({
    approval: makeApproval("file_write"),
    globalAutoApprove: false,
    activeProfile: null,
  });
  assertDecision(r, false, "global_toggle");
});

test("shouldAutoApprove can auto-run only worker-proposed file writes", () => {
  const r = shouldAutoApprove({
    approval: makeApproval("file_write"),
    globalAutoApprove: false,
    activeProfile: null,
    workerFileActionAutoApprove: true,
    isWorkerFileAction: true,
  });
  assertDecision(r, true, "worker_file_action");
});

test("shouldAutoApprove does not treat non-worker file writes as worker auto actions", () => {
  const r = shouldAutoApprove({
    approval: makeApproval("file_write"),
    globalAutoApprove: false,
    activeProfile: null,
    workerFileActionAutoApprove: true,
    isWorkerFileAction: false,
  });
  assertDecision(r, false, "global_toggle");
});

test("shouldAutoApprove worker file auto-run stays under profile block list", () => {
  const r = shouldAutoApprove({
    approval: makeApproval("file_write"),
    globalAutoApprove: false,
    activeProfile: {
      permissions: {
        autoApproveActions: [],
        blockedActions: ["file_write"],
        allowedSkillIds: [],
        toolAllowlist: [],
        toolDenylist: [],
      },
    },
    workerFileActionAutoApprove: true,
    isWorkerFileAction: true,
  });
  assertDecision(r, false, "blocked_action");
});

test("isWorkerFileActionApproval recognizes worker checkpoint file writes", () => {
  const approval = makeApproval("file_write");
  assert.equal(
    isWorkerFileActionApproval({
      approval,
      checkpoints: [
        {
          id: "ckp_1",
          summary: workerActionCheckpointSummary(2),
        },
      ],
    }),
    true,
  );
});

test("isWorkerFileActionApproval rejects same checkpoint for non-file actions", () => {
  assert.equal(
    isWorkerFileActionApproval({
      approval: makeApproval("shell"),
      checkpoints: [
        {
          id: "ckp_1",
          summary: workerActionCheckpointSummary(1),
        },
      ],
    }),
    false,
  );
});

test("shouldAutoApprove honors profile.permissions.autoApproveActions even when global is off", () => {
  // Per-profile override expands the policy beyond the global toggle so
  // power-users can auto-approve specific safe actions without trusting
  // every action type.
  const r = shouldAutoApprove({
    approval: makeApproval("file_write"),
    globalAutoApprove: false,
    activeProfile: {
      permissions: {
        autoApproveActions: ["file_write"],
        blockedActions: [],
        allowedSkillIds: [],
        toolAllowlist: [],
        toolDenylist: [],
      },
    },
  });
  assertDecision(r, true, "profile_auto_approve");
});

test("shouldAutoApprove blocks budget overruns before profile auto approval", () => {
  const r = shouldAutoApprove({
    approval: {
      ...makeApproval("model_use"),
      policyEvaluation: {
        operation: { kind: "approval_action", actionType: "model_use" },
        decision: "confirm",
        riskLevel: "medium",
        allowAutoApprove: true,
        reason: "model selection",
        costEstimateUsd: 0.2,
      },
    },
    globalAutoApprove: false,
    accumulatedTaskRunCostUsd: 0,
    accumulatedDailyCostUsd: 0,
    activeProfile: {
      permissions: {
        autoApproveActions: ["model_use"],
        blockedActions: [],
        allowedSkillIds: [],
        toolAllowlist: [],
        toolDenylist: [],
        budget: { perInvocationUsd: 0.1 },
      },
    },
  });
  assertDecision(r, false, "budget_blocked");
});

test("shouldAutoApprove still rejects action types that aren't on the profile whitelist", () => {
  const r = shouldAutoApprove({
    approval: makeApproval("shell"),
    globalAutoApprove: false,
    activeProfile: {
      permissions: {
        autoApproveActions: ["file_write"],
        blockedActions: [],
        allowedSkillIds: [],
        toolAllowlist: [],
        toolDenylist: [],
      },
    },
  });
  assertDecision(r, false, "global_toggle");
});

test("shouldAutoApprove rejects when actionType is in profile.blockedActions, even if global is on", () => {
  // Block list wins. A "trust everything" global toggle must not bypass
  // an explicit profile-level prohibition (e.g. for production agents).
  const r = shouldAutoApprove({
    approval: makeApproval("git_commit"),
    globalAutoApprove: true,
    activeProfile: {
      permissions: {
        autoApproveActions: [],
        blockedActions: ["git_commit"],
        allowedSkillIds: [],
        toolAllowlist: [],
        toolDenylist: [],
      },
    },
  });
  assertDecision(r, false, "blocked_action");
});

test("shouldAutoApprove honors blocked policy evaluation before global autoApprove", () => {
  const r = shouldAutoApprove({
    approval: {
      ...makeApproval("network"),
      policyEvaluation: {
        operation: { kind: "approval_action", actionType: "network" },
        decision: "blocked",
        riskLevel: "blocked",
        allowAutoApprove: false,
        reason: "network blocked by policy",
      },
    },
    globalAutoApprove: true,
    activeProfile: null,
  });
  assertDecision(r, false, "policy_blocked");
});

test("shouldAutoApprove honors allowAutoApprove=false before global autoApprove", () => {
  const r = shouldAutoApprove({
    approval: {
      ...makeApproval("dependency_install"),
      policyEvaluation: {
        operation: {
          kind: "approval_action",
          actionType: "dependency_install",
        },
        decision: "confirm",
        riskLevel: "high",
        allowAutoApprove: false,
        reason: "dependency installs require manual confirmation",
      },
    },
    globalAutoApprove: true,
    activeProfile: null,
  });
  assertDecision(r, false, "policy_disallow_auto");
});

test("shouldAutoApprove lets explicit profile auto-approval override manual-only policy", () => {
  const r = shouldAutoApprove({
    approval: {
      ...makeApproval("dependency_install"),
      policyEvaluation: {
        operation: {
          kind: "approval_action",
          actionType: "dependency_install",
        },
        decision: "confirm",
        riskLevel: "high",
        allowAutoApprove: false,
        reason: "dependency installs require manual confirmation by default",
      },
    },
    globalAutoApprove: false,
    activeProfile: {
      permissions: {
        autoApproveActions: ["dependency_install"],
        blockedActions: [],
        allowedSkillIds: [],
        toolAllowlist: [],
        toolDenylist: [],
      },
    },
  });
  assertDecision(r, true, "profile_auto_approve");
});

test("shouldAutoApprove blockedActions also win over autoApproveActions on the same profile", () => {
  const r = shouldAutoApprove({
    approval: makeApproval("file_write"),
    globalAutoApprove: false,
    activeProfile: {
      permissions: {
        autoApproveActions: ["file_write"],
        blockedActions: ["file_write"], // contradiction → block wins
        allowedSkillIds: [],
        toolAllowlist: [],
        toolDenylist: [],
      },
    },
  });
  assertDecision(r, false, "blocked_action");
});
