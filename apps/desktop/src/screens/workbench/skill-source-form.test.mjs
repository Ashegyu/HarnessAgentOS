import { test } from "node:test";
import assert from "node:assert/strict";
import {
  describeStatus,
  emptyAddDraft,
  normalizePath,
  validateAddDraft,
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

test("emptyAddDraft returns empty strings", () => {
  const d = emptyAddDraft();
  assert.equal(d.name, "");
  assert.equal(d.rootDir, "");
});
