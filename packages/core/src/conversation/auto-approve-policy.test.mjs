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

test("shouldAutoApprove returns true when global autoApprove is on and no profile override", () => {
  const r = shouldAutoApprove({
    approval: makeApproval("file_write"),
    globalAutoApprove: true,
    activeProfile: null,
  });
  assert.equal(r, true);
});

test("shouldAutoApprove returns false when global autoApprove is off and no profile override", () => {
  const r = shouldAutoApprove({
    approval: makeApproval("file_write"),
    globalAutoApprove: false,
    activeProfile: null,
  });
  assert.equal(r, false);
});

test("shouldAutoApprove can auto-run only worker-proposed file writes", () => {
  const r = shouldAutoApprove({
    approval: makeApproval("file_write"),
    globalAutoApprove: false,
    activeProfile: null,
    workerFileActionAutoApprove: true,
    isWorkerFileAction: true,
  });
  assert.equal(r, true);
});

test("shouldAutoApprove does not treat non-worker file writes as worker auto actions", () => {
  const r = shouldAutoApprove({
    approval: makeApproval("file_write"),
    globalAutoApprove: false,
    activeProfile: null,
    workerFileActionAutoApprove: true,
    isWorkerFileAction: false,
  });
  assert.equal(r, false);
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
  assert.equal(r, false);
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
  assert.equal(r, true);
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
  assert.equal(r, false);
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
  assert.equal(r, false);
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
  assert.equal(r, false);
});
