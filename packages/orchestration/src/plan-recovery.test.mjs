import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb, closeDb, LocalStateService } from "../../storage/src/index.ts";
import { OrchestrationService, parseEmbeddedPlanJson } from "./orchestration-service.ts";
import { formatPlanSummary } from "./orchestration-trace.ts";

const marker = "<!-- orchestration-plan:json -->";
const examplePlan = {
  id: "instruction-example-plan", mode: "single_worker",
  workerSteps: [{ id: "example-step", title: "Example, never execute", role: "coder",
    inputSummary: "example", instruction: "Example only", expectedArtifactKinds: ["log"], status: "pending" }],
  sourcePipelineId: "instruction-example-pipeline",
};
const official = { ...examplePlan, id: "official-plan", sourcePipelineId: "official-pipeline",
  workerSteps: [{ ...examplePlan.workerSteps[0], id: "official-step", title: "Approved worker" }] };
const fence = value => "```json\n" + JSON.stringify(value) + "\n```";
const summary = (plan, instruction = "") => `${formatPlanSummary({ mode: plan.mode,
  workerSteps: plan.workerSteps, instruction })}\n\n${marker}\n${fence(plan)}\n`;

const fixture = async (instruction = "") => {
  const db = openDb({ filePath: ":memory:" });
  const state = new LocalStateService(db);
  const thread = await state.createThread({ title: "approved plan recovery", targetDir: "/tmp/project" });
  const task = await state.createTaskRun({ threadId: thread.id, userRequest: "Implement the requested change", targetDir: "/tmp/project", status: "running" });
  const service = new OrchestrationService({ state, enabled: () => true });
  const drafted = await service.draftPlan({ taskRunId: task.id, mode: "single_worker", instruction });
  await state.decideApproval(drafted.approval.id, "approved", "run the official plan");
  return { db, state, task, service, drafted };
};

for (const [name, instruction] of [
  ["ordinary JSON example", fence({ enabled: true })],
  ["plan-shaped example", fence(examplePlan)],
  ["nested JSON fence", "````markdown\n" + fence(examplePlan) + "\n````"],
  ["marker-shaped example", `${marker}\n${fence(examplePlan)}`],
]) {
  test(`official plan recovery ignores an instruction's ${name}`, async () => {
    const f = await fixture(instruction);
    try {
      const latest = await f.service.getLatestPlan({ taskRunId: f.task.id });
      assert.equal(latest?.id, f.drafted.plan.id);
      assert.equal(latest?.sourcePipelineId, undefined, "instruction examples cannot establish pipeline consent");
      const result = await f.service.runApproved({ approvalId: f.drafted.approval.id });
      assert.equal(result.planId, f.drafted.plan.id);
      assert.deepEqual(result.workerSteps.map(step => step.id), f.drafted.plan.workerSteps.map(step => step.id));
    } finally { closeDb(f.db); }
  });
}

test("official framing remains recoverable when its JSON instruction contains literal marker and fences", () => {
  const plan = { ...official, workerSteps: [{ ...official.workerSteps[0],
    instruction: `Use ${marker} as text.\n${marker}\n${fence(examplePlan)}\nDo not execute the example.` }] };
  const text = summary(plan, plan.workerSteps[0].instruction);
  assert.equal(parseEmbeddedPlanJson(text)?.id, plan.id);
  assert.equal(parseEmbeddedPlanJson(text)?.workerSteps[0].instruction, plan.workerSteps[0].instruction);
});

test("a broken official JSON frame never falls back to an earlier instruction example", () => {
  const text = `${formatPlanSummary({ mode: official.mode, workerSteps: official.workerSteps,
    instruction: fence(examplePlan) })}\n\n${marker}\n\`\`\`json\n{"id":\n\`\`\`\n`;
  assert.equal(parseEmbeddedPlanJson(text), null);
});

for (const [name, mutate] of [
  ["invalid mode", plan => ({ ...plan, mode: "execute_all" })],
  ["invalid plan id", plan => ({ ...plan, id: 42 })],
  ["malformed worker", plan => ({ ...plan, workerSteps: [{ id: "step" }] })],
  ["unknown worker role", plan => ({ ...plan, workerSteps: [{ ...plan.workerSteps[0], role: "executor" }] })],
  ["invalid dependency", plan => ({ ...plan, workerSteps: [{ ...plan.workerSteps[0], dependsOn: ["unknown"] }] })],
  ["invalid backflow", plan => ({ ...plan, backflowRules: [{ id: "rule", trigger: "step_failed", targetStepId: "missing", retryStepId: "missing", maxAttempts: 99 }] })],
]) {
  test(`malformed persisted ${name} cannot be recovered as an execution plan`, () => {
    assert.equal(parseEmbeddedPlanJson(`${marker}\n${fence(mutate(official))}\n`), null);
  });
}

for (const corruption of ["artifact URI", "checkpoint plan id", "checkpoint artifact id"]) {
  test(`recovery refuses an approved plan with a mismatched ${corruption}`, async () => {
    const f = await fixture();
    try {
      const checkpoint = (await f.state.listCheckpointsByTaskRun(f.task.id)).find(row => row.id === f.drafted.approval.checkpointId);
      if (corruption === "artifact URI") {
        f.db.prepare("UPDATE artifacts SET uri = ? WHERE id = ?").run(`harness:orchestration/${f.task.id}/another-plan`, f.drafted.artifact.id);
        assert.equal(await f.service.getLatestPlan({ taskRunId: f.task.id }), null);
      } else {
        const stateRef = JSON.parse(checkpoint.stateRef);
        if (corruption === "checkpoint plan id") stateRef.orchestrationPlanId = "another-plan";
        else stateRef.artifactIds = ["missing-artifact"];
        f.db.prepare("UPDATE checkpoints SET state_ref = ? WHERE id = ?").run(JSON.stringify(stateRef), checkpoint.id);
      }
      await assert.rejects(f.service.runApproved({ approvalId: f.drafted.approval.id }), error => error.code === "ORCHESTRATION_PLAN_NOT_FOUND");
      assert.equal((await f.state.listArtifactsByTaskRun(f.task.id)).filter(row => row.title.startsWith("Worker output:")).length, 0);
    } finally { closeDb(f.db); }
  });
}

test("marker-less markdown JSON cannot become a stored execution plan", async () => {
  const f = await fixture();
  try {
    f.db.prepare("UPDATE artifacts SET summary = ? WHERE id = ?").run(fence({ ...official, id: f.drafted.plan.id }), f.drafted.artifact.id);
    assert.equal(await f.service.getLatestPlan({ taskRunId: f.task.id }), null);
    await assert.rejects(f.service.runApproved({ approvalId: f.drafted.approval.id }), error => error.code === "ORCHESTRATION_PLAN_NOT_FOUND");
  } finally { closeDb(f.db); }
});

test("the exported parser accepts the already-framed fragment used by the progression host", () => {
  assert.equal(parseEmbeddedPlanJson(`\n${fence(official)}\n`)?.sourcePipelineId, official.sourcePipelineId);
});
