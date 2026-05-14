import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, closeDb, LocalStateService } from "../../../../packages/storage/src/index.ts";
import { ConversationService } from "./conversation-service.ts";

const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), "hgos-conv-"));
  return {
    dir,
    file: join(dir, "test.db"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
};

const makeService = (t, opts = {}) => {
  const db = openDb({ filePath: t.file });
  const state = new LocalStateService(db);
  const conversation = new ConversationService({
    state,
    pathExists: opts.pathExists ?? (async () => true),
  });
  return { db, state, conversation };
};

test("createTask emits TaskRun, plan artifact, before_edit checkpoint, approvals", async () => {
  const t = tmp();
  const { db, state, conversation } = makeService(t);
  try {
    const draft = await conversation.createTask({
      userRequest: "리팩토링 진행",
      targetDir: "/tmp/project",
    });
    assert.equal(draft.taskRun.status, "waiting_for_approval");
    assert.equal(draft.planArtifact.kind, "plan");
    assert.equal(draft.checkpoint.reason, "before_edit");
    assert.ok(draft.approvals.length >= 1);
    for (const a of draft.approvals) assert.equal(a.status, "pending");

    // Steps should include inspect + plan + approval (3 minimum).
    const steps = await state.listStepsByTaskRun(draft.taskRun.id);
    const kinds = steps.map((s) => s.kind);
    assert.ok(kinds.includes("inspect"));
    assert.ok(kinds.includes("plan"));
    assert.ok(kinds.includes("approval"));
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("createTask rejects empty userRequest", async () => {
  const t = tmp();
  const { db, conversation } = makeService(t);
  try {
    await assert.rejects(() =>
      conversation.createTask({ userRequest: "  ", targetDir: "/tmp/x" }),
    );
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("createTask rejects non-existent targetDir", async () => {
  const t = tmp();
  const { db, conversation } = makeService(t, { pathExists: async () => false });
  try {
    await assert.rejects(() =>
      conversation.createTask({
        userRequest: "x",
        targetDir: "/nope",
      }),
    );
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("rejectApproval requires non-empty message and pauses TaskRun", async () => {
  const t = tmp();
  const { db, state, conversation } = makeService(t);
  try {
    const draft = await conversation.createTask({
      userRequest: "x",
      targetDir: "/tmp",
    });
    const firstApproval = draft.approvals[0];
    assert.ok(firstApproval);

    await assert.rejects(() =>
      conversation.rejectApproval({
        approvalId: firstApproval.id,
        message: "   ",
      }),
    );

    const updated = await conversation.rejectApproval({
      approvalId: firstApproval.id,
      message: "wrong direction",
    });
    assert.equal(updated.status, "rejected");
    assert.equal(updated.decisionMessage, "wrong direction");

    const tr = await state.getTaskRun(draft.taskRun.id);
    assert.equal(tr.status, "paused");
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("rejectApproval for capability_use keeps drafting TaskRun active", async () => {
  const t = tmp();
  const { db, state, conversation } = makeService(t);
  try {
    const draft = await conversation.createTask({
      userRequest: "refactor helper",
      targetDir: "/tmp",
      mode: "agent",
    });
    const step = await state.createStep({
      taskRunId: draft.taskRun.id,
      index: 2,
      kind: "approval",
      title: "Skill 후보 승인 대기",
      status: "pending",
      inputSummary: "refactor",
    });
    const checkpoint = await state.createCheckpoint({
      taskRunId: draft.taskRun.id,
      stepId: step.id,
      reason: "before_edit",
      stateRef: "{}",
      summary: "skill candidate checkpoint",
    });
    const approval = await state.createApproval({
      taskRunId: draft.taskRun.id,
      checkpointId: checkpoint.id,
      actionType: "capability_use",
      actionSummary: "Skill 후보 사용: refactor",
      status: "pending",
      proposedAction: {
        type: "capability_use",
        capabilityUse: {
          capabilityId: "cap_refactor",
          capabilityName: "refactor",
          reason: "Matched trigger terms: refactor",
          matchedTerms: ["refactor"],
        },
      },
    });

    const updated = await conversation.rejectApproval({
      approvalId: approval.id,
      message: "이번 작업에는 불필요",
    });
    assert.equal(updated.status, "rejected");
    const tr = await state.getTaskRun(draft.taskRun.id);
    assert.equal(tr.status, "drafting");
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("rejectApproval for model_use keeps drafting TaskRun active", async () => {
  const t = tmp();
  const { db, state, conversation } = makeService(t);
  try {
    const draft = await conversation.createTask({
      userRequest: "analyze architecture",
      targetDir: "/tmp",
      mode: "agent",
    });
    const step = await state.createStep({
      taskRunId: draft.taskRun.id,
      index: 2,
      kind: "approval",
      title: "Learner 추천 승인 대기",
      status: "pending",
      inputSummary: "gpt-5.5",
    });
    const checkpoint = await state.createCheckpoint({
      taskRunId: draft.taskRun.id,
      stepId: step.id,
      reason: "before_edit",
      stateRef: "{}",
      summary: "learner recommendation checkpoint",
    });
    const approval = await state.createApproval({
      taskRunId: draft.taskRun.id,
      checkpointId: checkpoint.id,
      actionType: "model_use",
      actionSummary: "Learner 모델 추천 사용: gpt-5.5",
      status: "pending",
      proposedAction: {
        type: "model_use",
        modelUse: {
          model: "gpt-5.5",
          reason: "Highest reward",
          recommendationId: "rec_1",
          confidence: 0.7,
        },
      },
    });

    const updated = await conversation.rejectApproval({
      approvalId: approval.id,
      message: "이번에는 기본 모델 사용",
    });
    assert.equal(updated.status, "rejected");
    const tr = await state.getTaskRun(draft.taskRun.id);
    assert.equal(tr.status, "drafting");
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("approve marks approval as approved or same run action class", async () => {
  const t = tmp();
  const { db, state, conversation } = makeService(t);
  try {
    const draft = await conversation.createTask({
      userRequest: "x",
      targetDir: "/tmp",
    });
    const a0 = draft.approvals[0];

    const r1 = await conversation.approve({ approvalId: a0.id });
    assert.equal(r1.status, "approved");

    const draft2 = await conversation.createTask({
      userRequest: "y",
      targetDir: "/tmp",
    });
    const scopedBase = draft2.approvals[0];
    const sameAction = await state.createApproval({
      taskRunId: draft2.taskRun.id,
      checkpointId: draft2.checkpoint.id,
      actionType: scopedBase.actionType,
      actionSummary: "same action class",
      status: "pending",
    });
    const otherAction = await state.createApproval({
      taskRunId: draft2.taskRun.id,
      checkpointId: draft2.checkpoint.id,
      actionType: "shell",
      actionSummary: "different action class",
      status: "pending",
    });

    const r2 = await conversation.approve({
      approvalId: scopedBase.id,
      scope: "run_action_class",
    });
    assert.equal(r2.status, "always_approved_for_run");
    assert.equal(
      (await state.getApproval(sameAction.id)).status,
      "always_approved_for_run",
    );
    assert.equal((await state.getApproval(otherAction.id)).status, "pending");
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("redirectTask cancels pending approvals and creates a fresh draft", async () => {
  const t = tmp();
  const { db, state, conversation } = makeService(t);
  try {
    const draft = await conversation.createTask({
      userRequest: "first attempt",
      targetDir: "/tmp",
    });
    const initialPending = draft.approvals.length;
    assert.ok(initialPending >= 1);

    const redirected = await conversation.redirectTask({
      taskRunId: draft.taskRun.id,
      instruction: "다른 방식으로 시도해줘",
    });
    assert.ok(redirected.approvals.length >= 1);
    for (const a of redirected.approvals) assert.equal(a.status, "pending");

    const allApprovals = await state.listApprovalsByTaskRun(draft.taskRun.id);
    const rejectedOnes = allApprovals.filter((a) => a.status === "rejected");
    assert.equal(rejectedOnes.length, initialPending);
    assert.match(rejectedOnes[0].decisionMessage ?? "", /Replaced by redirect/);
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("createTask leaves no orphan TaskRun rows when targetDir is invalid", async () => {
  const t = tmp();
  const { db, state, conversation } = makeService(t);
  try {
    await assert.rejects(() =>
      conversation.createTask({
        userRequest: "x",
        targetDir: "relative/path",
      }),
    );
    const threads = await state.listThreads();
    assert.equal(threads.length, 0);
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("createTask rejects legacy parent thread with relative targetDir", async () => {
  const t = tmp();
  const { db, state, conversation } = makeService(t);
  try {
    const thread = await state.threads.create({
      title: "legacy relative",
      targetDir: "relative/path",
    });
    await assert.rejects(
      () =>
        conversation.createTask({
          threadId: thread.id,
          userRequest: "x",
        }),
      (e) =>
        e.code === "CONVERSATION_INVALID_TARGET_DIR" &&
        /absolute path/.test(e.message),
    );
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("pauseTask only allowed from running/waiting_for_approval", async () => {
  const t = tmp();
  const { db, state, conversation } = makeService(t);
  try {
    const draft = await conversation.createTask({
      userRequest: "x",
      targetDir: "/tmp",
    });
    const paused = await conversation.pauseTask({ taskRunId: draft.taskRun.id });
    assert.equal(paused.status, "paused");

    // Calling again from paused should be refused.
    await assert.rejects(
      () => conversation.pauseTask({ taskRunId: draft.taskRun.id }),
      (e) => e.code === "CONVERSATION_INVALID_STATE",
    );

    // After cancellation, pause is also refused.
    await conversation.cancelTask({
      taskRunId: draft.taskRun.id,
      reason: "test",
    });
    await assert.rejects(
      () => conversation.pauseTask({ taskRunId: draft.taskRun.id }),
      (e) => e.code === "CONVERSATION_INVALID_STATE",
    );
    void state;
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("resumeTask returns to waiting_for_approval when pending approvals remain", async () => {
  const t = tmp();
  const { db, conversation } = makeService(t);
  try {
    const draft = await conversation.createTask({
      userRequest: "x",
      targetDir: "/tmp",
    });
    await conversation.pauseTask({ taskRunId: draft.taskRun.id });
    const resumed = await conversation.resumeTask({
      taskRunId: draft.taskRun.id,
    });
    assert.equal(resumed.status, "waiting_for_approval");
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("resumeTask refuses when not paused", async () => {
  const t = tmp();
  const { db, conversation } = makeService(t);
  try {
    const draft = await conversation.createTask({
      userRequest: "x",
      targetDir: "/tmp",
    });
    await assert.rejects(
      () => conversation.resumeTask({ taskRunId: draft.taskRun.id }),
      (e) => e.code === "CONVERSATION_INVALID_STATE",
    );
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("cancelTask requires non-empty reason and writes a quality_report artifact", async () => {
  const t = tmp();
  const { db, state, conversation } = makeService(t);
  try {
    const draft = await conversation.createTask({
      userRequest: "x",
      targetDir: "/tmp",
    });
    await assert.rejects(
      () =>
        conversation.cancelTask({
          taskRunId: draft.taskRun.id,
          reason: "  ",
        }),
      (e) => e.code === "CONVERSATION_REASON_REQUIRED",
    );

    const cancelled = await conversation.cancelTask({
      taskRunId: draft.taskRun.id,
      reason: "no longer needed",
    });
    assert.equal(cancelled.status, "cancelled");

    // All previously pending approvals must now be rejected with the reason.
    const approvals = await state.listApprovalsByTaskRun(draft.taskRun.id);
    for (const a of approvals) {
      assert.equal(a.status, "rejected");
      assert.match(a.decisionMessage ?? "", /Cancelled/);
    }
    const artifacts = await state.listArtifactsByTaskRun(draft.taskRun.id);
    assert.ok(artifacts.some((a) => a.kind === "quality_report"));
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("cancelTask refuses when TaskRun is already terminal", async () => {
  const t = tmp();
  const { db, conversation } = makeService(t);
  try {
    const draft = await conversation.createTask({
      userRequest: "x",
      targetDir: "/tmp",
    });
    await conversation.cancelTask({
      taskRunId: draft.taskRun.id,
      reason: "first",
    });
    await assert.rejects(
      () =>
        conversation.cancelTask({
          taskRunId: draft.taskRun.id,
          reason: "second",
        }),
      (e) => e.code === "CONVERSATION_INVALID_STATE",
    );
  } finally {
    closeDb(db);
    t.cleanup();
  }
});
