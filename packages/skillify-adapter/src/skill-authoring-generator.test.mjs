import { test } from "node:test";
import assert from "node:assert/strict";
import { buildGeneratedSkillDraft } from "./skill-authoring-generator.ts";

test("buildGeneratedSkillDraft creates a valid deterministic skill draft", () => {
  const first = buildGeneratedSkillDraft({
    sourceId: "ss_user",
    userIntent: "Create a review workflow that checks risky diffs before file edits.",
    profileIds: ["ap_reviewer"],
    evidenceArtifactIds: [],
  });
  const second = buildGeneratedSkillDraft({
    sourceId: "ss_user",
    userIntent: "Create a review workflow that checks risky diffs before file edits.",
    profileIds: ["ap_reviewer"],
    evidenceArtifactIds: [],
  });

  assert.equal(first.slug, second.slug);
  assert.match(first.slug, /^[a-z0-9][a-z0-9_-]{1,62}$/);
  assert.equal(first.sourceId, "ss_user");
  assert.equal(first.riskLevel, "medium");
  assert.ok(first.allowedActions.includes("file_write"));
  assert.ok(first.triggerTerms.includes("review"));
  assert.deepEqual(first.recommendedProfileIds, ["ap_reviewer"]);
  assert.match(first.body, /Harness approval and runner execution/);
});

test("buildGeneratedSkillDraft keeps non-ASCII intents usable", () => {
  const draft = buildGeneratedSkillDraft({
    sourceId: "ss_user",
    userIntent: "품질 게이트 실패 후 수정 계획을 작성하는 스킬",
    evidenceArtifactIds: [],
  });

  assert.match(draft.slug, /^generated-skill-[a-f0-9]{6}$/);
  assert.ok(draft.triggerTerms.includes("품질"));
  assert.ok(draft.allowedActions.includes("file_write"));
});
