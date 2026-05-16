import { test } from "node:test";
import assert from "node:assert/strict";
import { planWorkerWaves } from "./worker-wave-planner.ts";

const worker = (overrides) => ({
  id: overrides.id,
  title: overrides.title ?? overrides.id,
  role: overrides.role ?? "planner",
  inputSummary: overrides.inputSummary ?? "summary",
  instruction: overrides.instruction ?? "instruction",
  expectedArtifactKinds: overrides.expectedArtifactKinds ?? ["log"],
  status: overrides.status ?? "pending",
  ...overrides,
});

const remoteEntry = (overrides = {}) => ({
  endpoint: {
    id: overrides.id ?? "a2a_remote",
    name: overrides.name ?? "Remote Reviewer",
    baseUrl: "https://agents.example.com/reviewer",
    agentCardUrl: "https://agents.example.com/reviewer/.well-known/agent-card.json",
    preferredTransport: "json-rpc",
    enabled: overrides.enabled ?? true,
    trusted: overrides.trusted ?? true,
    createdAt: "2026-05-15T00:00:00.000Z",
    updatedAt: "2026-05-15T00:00:00.000Z",
  },
});

test("planWorkerWaves groups independent explicit read-only reviewer/planner steps", () => {
  const plan = planWorkerWaves([
    worker({ id: "plan", role: "planner", dependsOn: [], allowedActions: [] }),
    worker({ id: "review", role: "reviewer", dependsOn: [], allowedActions: [] }),
  ]);

  assert.equal(plan.waves.length, 1);
  assert.deepEqual(plan.waves[0].stepIds, ["plan", "review"]);
  assert.equal(plan.waves[0].parallelizable, true);
  assert.deepEqual(plan.deterministicOrder, ["plan", "review"]);
});

test("planWorkerWaves keeps default linear dependencies when dependsOn is absent", () => {
  const plan = planWorkerWaves([
    worker({ id: "plan", role: "planner", allowedActions: [] }),
    worker({ id: "review", role: "reviewer", allowedActions: [] }),
  ]);

  assert.equal(plan.waves.length, 2);
  assert.deepEqual(plan.waves.map((wave) => wave.stepIds), [
    ["plan"],
    ["review"],
  ]);
  assert.equal(plan.waves[1].steps[0].dependencyIds[0], "plan");
});

test("planWorkerWaves marks side-effect, role, and remote blockers", () => {
  const plan = planWorkerWaves(
    [
      worker({
        id: "code",
        role: "coder",
        dependsOn: [],
        allowedActions: ["file_write"],
        remoteEndpointId: "a2a_remote",
      }),
    ],
    [remoteEntry({ id: "a2a_remote", trusted: false })],
  );

  const step = plan.waves[0].steps[0];
  assert.equal(step.canRunReadOnlyParallel, false);
  assert.equal(step.remoteEndpointTrusted, false);
  assert.ok(step.blockers.some((blocker) => /side-effect/.test(blocker)));
  assert.ok(step.blockers.some((blocker) => /coder role/.test(blocker)));
  assert.ok(step.blockers.some((blocker) => /untrusted/.test(blocker)));
  assert.equal(plan.waves[0].hasSideEffects, true);
});

test("planWorkerWaves preserves deterministic output order across dependency waves", () => {
  const plan = planWorkerWaves([
    worker({ id: "plan", role: "planner", dependsOn: [], allowedActions: [] }),
    worker({
      id: "review",
      role: "reviewer",
      dependsOn: ["plan"],
      allowedActions: [],
    }),
    worker({
      id: "docs",
      role: "reviewer",
      dependsOn: ["plan"],
      allowedActions: [],
    }),
  ]);

  assert.deepEqual(plan.waves.map((wave) => wave.stepIds), [
    ["plan"],
    ["review", "docs"],
  ]);
  assert.equal(plan.waves[1].parallelizable, true);
  assert.deepEqual(plan.deterministicOrder, ["plan", "review", "docs"]);
});
