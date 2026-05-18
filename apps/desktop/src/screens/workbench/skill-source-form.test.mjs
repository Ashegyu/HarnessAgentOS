import { test } from "node:test";
import assert from "node:assert/strict";
import {
  capabilityCountForSource,
  describeStatus,
  emptyAddDraft,
  emptySkillAuthorDraft,
  normalizePath,
  skillAuthorDraftToInput,
  skillAuthorInputToFormDraft,
  skillSlugFromName,
  skillSourceCapabilitySourceKey,
  validateAddDraft,
  validateSkillAuthorDraft,
} from "./skill-source-form.ts";

const SOURCE = (overrides = {}) => ({
  id: "ss_x",
  name: "X",
  origin: "custom",
  rootDir: "/tmp/skills",
  trusted: false,
  enabled: true,
  registeredInPathPolicy: false,
  createdAt: "2026-05-12T00:00:00.000Z",
  updatedAt: "2026-05-12T00:00:00.000Z",
  ...overrides,
});

test("validateAddDraft accepts a fresh non-empty draft", () => {
  const errors = validateAddDraft(
    { name: "Mine", rootDir: "C:\\Users\\me\\skills" },
    [],
  );
  assert.deepEqual(errors, []);
});

test("validateAddDraft rejects empty name", () => {
  const errors = validateAddDraft({ name: "  ", rootDir: "/tmp" }, []);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].field, "name");
});

test("validateAddDraft rejects empty rootDir", () => {
  const errors = validateAddDraft({ name: "A", rootDir: "" }, []);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].field, "rootDir");
});

test("validateAddDraft rejects rootDir that's already registered (case + slash insensitive)", () => {
  // The catch-it-early dup check uses normalizePath, so common Windows
  // vs POSIX differences ("C:\\X" vs "c:/x/") don't slip through.
  const existing = [SOURCE({ rootDir: "C:\\Users\\me\\skills" })];
  const errors = validateAddDraft(
    { name: "Dup", rootDir: "c:/users/me/skills/" },
    existing,
  );
  assert.equal(errors.length, 1);
  assert.equal(errors[0].field, "rootDir");
});

test("normalizePath collapses trailing slash and casing", () => {
  assert.equal(normalizePath("/Tmp/Skills/"), "/tmp/skills");
  assert.equal(normalizePath("C:\\Users\\me\\skills"), "c:/users/me/skills");
});

test("describeStatus reports 'trust 미승격' for an enabled-but-untrusted custom row", () => {
  const s = describeStatus(SOURCE({ enabled: true, trusted: false }));
  assert.equal(s.ready, false);
  assert.equal(s.reason, "trust 미승격");
  assert.equal(s.flags.trusted, false);
});

test("describeStatus reports ready for the seeded project sentinel state", () => {
  const s = describeStatus(
    SOURCE({
      origin: "project",
      trusted: true,
      enabled: true,
      registeredInPathPolicy: true,
    }),
  );
  assert.equal(s.ready, true);
  assert.equal(s.reason, undefined);
});

test("describeStatus prioritises 비활성 over trust missing", () => {
  // The UI should surface the most actionable problem first: a disabled
  // row is irrelevant until re-enabled, so trust state shouldn't even
  // be mentioned.
  const s = describeStatus(
    SOURCE({ enabled: false, trusted: false, registeredInPathPolicy: false }),
  );
  assert.equal(s.reason, "비활성");
});

test("skillSourceCapabilitySourceKey mirrors registry source keys", () => {
  assert.equal(
    skillSourceCapabilitySourceKey(
      SOURCE({ origin: "project", id: "ss_project" }),
    ),
    "skillify:project",
  );
  assert.equal(
    skillSourceCapabilitySourceKey(SOURCE({ origin: "user", id: "ss_user" })),
    "skillify:user",
  );
  assert.equal(
    skillSourceCapabilitySourceKey(SOURCE({ id: "ss_custom" })),
    "skillify:ss_custom",
  );
});

test("capabilityCountForSource counts only matching registry rows", () => {
  const count = capabilityCountForSource(SOURCE({ id: "ss_custom" }), [
    {
      id: "a",
      source: "skillify:ss_custom",
      name: "A",
      description: "A",
      triggerTerms: [],
      riskLevel: "low",
      requiresApproval: false,
    },
    {
      id: "b",
      source: "skillify:project",
      name: "B",
      description: "B",
      triggerTerms: [],
      riskLevel: "low",
      requiresApproval: false,
    },
  ]);
  assert.equal(count, 1);
});

test("emptyAddDraft returns empty strings", () => {
  const d = emptyAddDraft();
  assert.equal(d.name, "");
  assert.equal(d.rootDir, "");
});

test("skillSlugFromName creates a stable lowercase file-safe slug", () => {
  assert.equal(skillSlugFromName("Review Helper!"), "review-helper");
  assert.equal(skillSlugFromName("   "), "new-skill");
});

test("skillAuthorDraftToInput trims fields and splits trigger terms", () => {
  const input = skillAuthorDraftToInput({
    ...emptySkillAuthorDraft("ss_1"),
    slug: "Review-Helper",
    name: " Review Helper ",
    description: " Reviews diffs ",
    triggerTermsText: "review, diff\napproval",
    riskLevel: "medium",
    allowedActions: ["file_write"],
    body: "Body",
  });

  assert.equal(input.slug, "review-helper");
  assert.equal(input.name, "Review Helper");
  assert.deepEqual(input.triggerTerms, ["review", "diff", "approval"]);
  assert.deepEqual(input.allowedActions, ["file_write"]);
});

test("skillAuthorInputToFormDraft maps generated drafts back into the form", () => {
  const form = skillAuthorInputToFormDraft({
    sourceId: "ss_1",
    slug: "review-helper",
    name: "Review Helper",
    description: "Reviews diffs",
    triggerTerms: ["review", "diff"],
    riskLevel: "medium",
    allowedActions: ["file_write"],
    body: "Body",
  });

  assert.equal(form.sourceId, "ss_1");
  assert.equal(form.triggerTermsText, "review, diff");
  assert.deepEqual(form.allowedActions, ["file_write"]);
});

test("validateSkillAuthorDraft requires source, slug, name, and description", () => {
  const errors = validateSkillAuthorDraft(emptySkillAuthorDraft());
  assert.ok(errors.some((error) => error.field === "sourceId"));
  assert.ok(errors.some((error) => error.field === "slug"));
  assert.ok(errors.some((error) => error.field === "name"));
  assert.ok(errors.some((error) => error.field === "description"));
});
