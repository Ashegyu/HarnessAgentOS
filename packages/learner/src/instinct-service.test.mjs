import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  closeDb,
  LocalStateService,
  openDb,
} from "../../../packages/storage/src/index.ts";
import { InstinctService } from "./instinct-service.ts";
import { ObservationCollector } from "./observation-collector.ts";

const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), "hgos-instinct-service-"));
  return {
    dir,
    file: join(dir, "test.db"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
};

const seedTaskRun = async (state, targetDir) => {
  const thread = await state.createThread({
    title: "thread",
    targetDir,
  });
  return state.createTaskRun({
    threadId: thread.id,
    userRequest: "edit files",
    targetDir,
    status: "waiting_for_approval",
  });
};

const seedApproval = async (
  state,
  taskRun,
  actionType = "file_write",
  decision = "rejected",
) => {
  const step = await state.createStep({
    taskRunId: taskRun.id,
    index: 0,
    kind: "approval",
    title: "approval",
    status: "pending",
  });
  const checkpoint = await state.createCheckpoint({
    taskRunId: taskRun.id,
    stepId: step.id,
    reason: "approval required",
    stateRef: "sqlite",
    summary: "checkpoint",
  });
  const approval = await state.createApproval({
    taskRunId: taskRun.id,
    checkpointId: checkpoint.id,
    actionType,
    actionSummary: `Run ${actionType}`,
  });
  return state.decideApproval(
    approval.id,
    decision,
    decision === "rejected" ? "no" : "ok",
  );
};

test("InstinctService records repeated approval rejections as one pending candidate", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  const state = new LocalStateService(db);
  try {
    const collector = new ObservationCollector({
      state,
      projectKeyForTask: async () => "proj_test",
    });
    const service = new InstinctService({ state, collector, minSignals: 3 });
    for (let i = 0; i < 3; i += 1) {
      const taskRun = await seedTaskRun(state, t.dir);
      const approval = await seedApproval(state, taskRun);
      await service.recordApprovalDecision(approval);
    }

    const candidates = await service.listCandidates({ projectKey: "proj_test" });
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].projectKey, "proj_test");
    assert.equal(candidates[0].observationIds.length, 3);
    assert.match(candidates[0].proposedRule, /file_write/);

    const again = await service.listCandidates({ projectKey: "proj_test" });
    assert.equal(again.length, 1);
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("InstinctService does not create candidates from repeated approval approvals", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  const state = new LocalStateService(db);
  try {
    const collector = new ObservationCollector({
      state,
      projectKeyForTask: async () => "proj_test",
    });
    const service = new InstinctService({ state, collector, minSignals: 3 });
    for (let i = 0; i < 3; i += 1) {
      const taskRun = await seedTaskRun(state, t.dir);
      const approval = await seedApproval(
        state,
        taskRun,
        "file_write",
        "approved",
      );
      await service.recordApprovalDecision(approval);
    }

    const candidates = await service.listCandidates({ projectKey: "proj_test" });
    assert.deepEqual(candidates, []);
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("InstinctService approves and disables candidate-backed instincts", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  const state = new LocalStateService(db);
  try {
    const collector = new ObservationCollector({
      state,
      projectKeyForTask: async () => "proj_test",
    });
    const service = new InstinctService({ state, collector, minSignals: 3 });
    for (let i = 0; i < 3; i += 1) {
      const taskRun = await seedTaskRun(state, t.dir);
      const approval = await seedApproval(state, taskRun);
      await service.recordApprovalDecision(approval);
    }
    const [candidate] = await service.listCandidates({ projectKey: "proj_test" });
    const instinct = await service.approveCandidate({
      candidateId: candidate.id,
      message: "use this",
    });
    assert.equal(instinct.status, "active");
    assert.equal(instinct.scope, "project");
    assert.deepEqual(instinct.sourceObservationIds, candidate.observationIds);
    assert.equal(
      (await service.listCandidates({ projectKey: "proj_test" })).length,
      0,
    );

    const disabled = await service.disable({
      instinctId: instinct.id,
      reason: "not useful now",
    });
    assert.equal(disabled.status, "disabled");
    const hidden = await service.list({ projectKey: "proj_test" });
    assert.equal(hidden.length, 0);
    const visible = await service.list({
      projectKey: "proj_test",
      includeDisabled: true,
    });
    assert.equal(visible.length, 1);
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("InstinctService does not recreate a rejected rule after more matching observations", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  const state = new LocalStateService(db);
  try {
    const collector = new ObservationCollector({
      state,
      projectKeyForTask: async () => "proj_test",
    });
    const service = new InstinctService({ state, collector, minSignals: 3 });
    for (let i = 0; i < 3; i += 1) {
      const taskRun = await seedTaskRun(state, t.dir);
      const approval = await seedApproval(state, taskRun);
      await service.recordApprovalDecision(approval);
    }
    const [candidate] = await service.listCandidates({ projectKey: "proj_test" });
    await service.rejectCandidate({
      candidateId: candidate.id,
      message: "not useful",
    });

    const taskRun = await seedTaskRun(state, t.dir);
    const approval = await seedApproval(state, taskRun);
    await service.recordApprovalDecision(approval);

    const candidates = await service.listCandidates({ projectKey: "proj_test" });
    assert.equal(candidates.length, 0);
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("InstinctService records repeated failed quality gates", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  const state = new LocalStateService(db);
  try {
    const collector = new ObservationCollector({
      state,
      projectKeyForTask: async () => "proj_quality",
    });
    const service = new InstinctService({ state, collector, minSignals: 3 });
    for (let i = 0; i < 3; i += 1) {
      const taskRun = await seedTaskRun(state, t.dir);
      await service.recordQualityGate({
        id: `qg_${i}`,
        taskRunId: taskRun.id,
        status: "failed",
        knownRisks: [],
        evidenceArtifactIds: [],
        createdAt: new Date().toISOString(),
      });
    }
    const candidates = await service.listCandidates({ projectKey: "proj_quality" });
    assert.equal(candidates.length, 1);
    assert.match(candidates[0].title, /quality/i);
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("InstinctService records pinned context outcome when quality gate lands", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  const state = new LocalStateService(db);
  try {
    const collector = new ObservationCollector({
      state,
      projectKeyForTask: async () => "proj_context",
    });
    const service = new InstinctService({ state, collector, minSignals: 3 });
    const taskRun = await seedTaskRun(state, t.dir);
    const contextPackObservation = await state.createObservation({
      taskRunId: taskRun.id,
      threadId: taskRun.threadId,
      projectKey: "proj_context",
      source: "agent",
      eventType: "context_pack_created",
      signal: "context_pack",
      summary: "agent context pack prepared (2 sources)",
      payload: {
        contextPackArtifactId: "art-context-pack",
        promptInclusion: {
          pinnedObservationIds: ["obs-prior-failure", "obs-prior-repair"],
        },
      },
    });

    await service.recordQualityGate({
      id: "qg_passed",
      taskRunId: taskRun.id,
      status: "passed",
      knownRisks: [],
      evidenceArtifactIds: ["art-test-result"],
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    const observations = await state.listObservations({
      taskRunId: taskRun.id,
      limit: 10,
    });
    const outcome = observations.find(
      (observation) =>
        observation.source === "learner" &&
        observation.eventType === "pinned_context_outcome",
    );
    assert.ok(outcome, "pinned context outcome observation must be recorded");
    assert.equal(outcome.projectKey, "proj_context");
    assert.equal(outcome.signal, "passed");
    assert.match(outcome.summary, /2 pinned observations/);
    assert.deepEqual(outcome.payload.pinnedObservationIds, [
      "obs-prior-failure",
      "obs-prior-repair",
    ]);
    assert.equal(outcome.payload.contextPackObservationId, contextPackObservation.id);
    assert.equal(outcome.payload.contextPackArtifactId, "art-context-pack");
    assert.equal(outcome.payload.qualityGateId, "qg_passed");
    assert.equal(outcome.payload.qualityStatus, "passed");
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("InstinctService promotes repeated successful pinned context as pending candidate only", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  const state = new LocalStateService(db);
  try {
    const collector = new ObservationCollector({
      state,
      projectKeyForTask: async () => "proj_context",
    });
    const service = new InstinctService({ state, collector, minSignals: 3 });
    const source = await state.createObservation({
      projectKey: "proj_context",
      source: "quality",
      eventType: "failed",
      signal: "failed",
      summary: "quality failed until rebuild:node was run",
      payload: {},
    });

    for (let i = 0; i < 3; i += 1) {
      const taskRun = await seedTaskRun(state, t.dir);
      await state.createObservation({
        taskRunId: taskRun.id,
        threadId: taskRun.threadId,
        projectKey: "proj_context",
        source: "agent",
        eventType: "context_pack_created",
        signal: "context_pack",
        summary: "agent context pack prepared (1 source)",
        payload: {
          contextPackArtifactId: `art-context-pack-${i}`,
          promptInclusion: {
            pinnedObservationIds: [source.id],
          },
        },
      });
      await service.recordQualityGate({
        id: `qg_passed_${i}`,
        taskRunId: taskRun.id,
        status: "passed",
        knownRisks: [],
        evidenceArtifactIds: [`art-test-result-${i}`],
        createdAt: "2026-01-01T00:00:00.000Z",
      });
    }

    const candidates = await service.listCandidates({ projectKey: "proj_context" });
    assert.equal(candidates.length, 1);
    assert.match(candidates[0].title, /pinned context/i);
    assert.match(candidates[0].proposedRule, /surface proven context/i);
    assert.equal(candidates[0].status, "pending");
    assert.equal(candidates[0].observationIds.includes(source.id), true);
    assert.equal(candidates[0].observationIds.length, 4);
    assert.deepEqual(
      await service.list({ projectKey: "proj_context" }),
      [],
      "review is required before a candidate becomes an active Instinct",
    );
  } finally {
    closeDb(db);
    t.cleanup();
  }
});

test("InstinctService returns redacted candidate evidence without observation payloads", async () => {
  const t = tmp();
  const db = openDb({ filePath: t.file });
  const state = new LocalStateService(db);
  try {
    const service = new InstinctService({ state, minSignals: 3 });
    const observation = await state.createObservation({
      projectKey: "proj_evidence",
      source: "quality",
      eventType: "failed",
      signal: "failed",
      summary: "quality failed because api_key=super-secret-value was logged",
      payload: { raw: "do not expose payload" },
    });
    const candidate = await state.createEvolutionCandidate({
      projectKey: "proj_evidence",
      title: "Use prior failure evidence",
      proposedRule: "Review prior failure evidence before planning.",
      rationale: "Repeated evidence supports this rule.",
      confidence: 0.6,
      observationIds: [observation.id, "obs_missing"],
    });

    const evidence = await service.getCandidateEvidence({
      candidateId: candidate.id,
      limit: 5,
    });

    assert.equal(evidence.candidate.id, candidate.id);
    assert.equal(evidence.observationCount, 2);
    assert.deepEqual(evidence.missingObservationIds, ["obs_missing"]);
    assert.equal(evidence.observations.length, 1);
    assert.equal(evidence.observations[0].observationId, observation.id);
    assert.match(evidence.observations[0].summary, /\[REDACTED\]/);
    assert.equal(JSON.stringify(evidence).includes("super-secret-value"), false);
    assert.equal(JSON.stringify(evidence).includes("do not expose payload"), false);
    assert.equal("payload" in evidence.observations[0], false);
  } finally {
    closeDb(db);
    t.cleanup();
  }
});
