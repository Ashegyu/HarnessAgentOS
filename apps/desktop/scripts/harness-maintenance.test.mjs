import test from "node:test";
import assert from "node:assert/strict";
import { openDb, LocalStateService } from "../../../packages/storage/src/index.ts";
import { reconcileHarnesses } from "../../../scripts/maintenance/reconcile-harnesses.mjs";
import { HarnessPackageService, planWorkerWaves } from "../../../packages/orchestration/src/index.ts";

test("the saved parallel audit produces a three-worker wave followed by synthesis", async () => {
  const db = openDb({ filePath: ":memory:" });
  try {
    const state = new LocalStateService(db);
    await state.agentProfiles.ensureSeed();
    await reconcileHarnesses(db);
    const service = new HarnessPackageService({ state });
    const definition = await service.getPackage("harness_seed_parallel_audit");
    const [binding] = await service.listBindingSets({ packageId: definition.id });
    const preview = await service.previewPipelineDraft({ packageId: definition.id, bindings: binding.bindings });
    assert.equal(preview.ok, true);
    const profiles = await state.agentProfiles.list();
    const wave = planWorkerWaves(preview.pipeline.steps.map(step => ({ ...step,
      role: profiles.find(p => p.id === step.agentProfileId).role, inputSummary: step.instruction, status: "pending" })));
    assert.deepEqual(wave.waves.map(w => w.stepIds.length), [3, 1]);
    assert.equal(wave.waves[0].parallelizable, true);
    assert.ok(preview.pipeline.steps.every(s => s.allowedActions.length === 0));
  } finally { db.close(); }
});

test("harness reconciliation repairs roles, creates ready bindings, preserves other tables and is idempotent", async () => {
  const db = openDb({ filePath: ":memory:" });
  try {
    const state = new LocalStateService(db);
    await state.agentProfiles.ensureSeed();
    await state.harnessPackages.ensureSeed();
    const coder = (await state.agentProfiles.list()).find(p => p.name === "Coder");
    const review = await state.harnessPackages.get("harness_seed_code_review");
    const wrong = await state.harnessBindingSets.save({ packageId: review.id, workflowId: review.workflows[0].id,
      name: "사용자가 저장한 이름", bindings: [{ harnessAgentRef: "code-reviewer", agentProfileId: coder.id }] });
    const profilesBefore = db.prepare("SELECT * FROM agent_profiles ORDER BY id").all();
    const result = await reconcileHarnesses(db);
    assert.equal(result.repairedBindings.length, 1);
    assert.equal(result.newBindings.length, 17);
    assert.equal(result.unreadyRoutes.length, 0);
    assert.equal(result.unrelatedTablesUnchanged, true);
    assert.equal((await state.harnessBindingSets.get(wrong.id)).name, wrong.name);
    assert.deepEqual(db.prepare("SELECT * FROM agent_profiles ORDER BY id").all(), profilesBefore);
    const before = db.prepare("SELECT * FROM harness_binding_sets ORDER BY id").all();
    const again = await reconcileHarnesses(db);
    assert.equal(again.repairedBindings.length, 0);
    assert.equal(again.newBindings.length, 0);
    assert.deepEqual(db.prepare("SELECT * FROM harness_binding_sets ORDER BY id").all(), before);
  } finally { db.close(); }
});

test("harness reconciliation rolls back catalog and bindings together on save failure", async () => {
  const db = openDb({ filePath: ":memory:" });
  try {
    const state = new LocalStateService(db);
    await state.agentProfiles.ensureSeed();
    db.exec("CREATE TRIGGER reject_binding BEFORE INSERT ON harness_binding_sets BEGIN SELECT RAISE(ABORT, 'injected binding failure'); END");
    await assert.rejects(() => reconcileHarnesses(db), /injected binding failure/);
    assert.equal((await state.harnessPackages.list()).length, 0);
    assert.equal((await state.harnessBindingSets.list()).length, 0);
    assert.equal(db.inTransaction, false);
  } finally { db.close(); }
});

test("harness reconciliation does not reinterpret customized or remote bindings", async () => {
  const db = openDb({ filePath: ":memory:" });
  try {
    const state = new LocalStateService(db);
    await state.agentProfiles.ensureSeed();
    await state.harnessPackages.ensureSeed();
    const coder = (await state.agentProfiles.list()).find(p => p.name === "Coder");
    const review = await state.harnessPackages.get("harness_seed_code_review");
    review.overview.summary = "사용자가 의도한 특수 작업";
    await state.harnessPackages.save(review);
    const binding = await state.harnessBindingSets.save({ packageId: review.id, workflowId: review.workflows[0].id,
      name: "특수 연결", bindings: [{ harnessAgentRef: "code-reviewer", agentProfileId: coder.id }] });
    const security = await state.harnessPackages.get("harness_seed_security");
    const remote = await state.harnessBindingSets.save({ packageId: security.id, workflowId: security.workflows[0].id,
      name: "원격 연결 유지", bindings: [{ harnessAgentRef: "security-reviewer", agentProfileId: coder.id, remoteEndpointId: "remote-review" }] });
    await reconcileHarnesses(db);
    assert.deepEqual(await state.harnessPackages.get(review.id), review);
    assert.deepEqual(await state.harnessBindingSets.get(binding.id), binding);
    assert.deepEqual(await state.harnessBindingSets.get(remote.id), remote);
  } finally { db.close(); }
});
