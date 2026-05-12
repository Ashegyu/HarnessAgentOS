import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SKILL_SOURCE_ORIGINS,
  isSkillSource,
  isSkillSourceOrigin,
} from "./skill-source.ts";

test("SKILL_SOURCE_ORIGINS exposes project/user/custom", () => {
  assert.deepEqual([...SKILL_SOURCE_ORIGINS].sort(), [
    "custom",
    "project",
    "user",
  ]);
});

test("isSkillSourceOrigin accepts known origins", () => {
  assert.equal(isSkillSourceOrigin("project"), true);
  assert.equal(isSkillSourceOrigin("user"), true);
  assert.equal(isSkillSourceOrigin("custom"), true);
});

test("isSkillSourceOrigin rejects unknown values", () => {
  assert.equal(isSkillSourceOrigin("system"), false);
  assert.equal(isSkillSourceOrigin(""), false);
  assert.equal(isSkillSourceOrigin(null), false);
});

test("isSkillSource accepts a complete row", () => {
  const src = {
    id: "ss_custom1234",
    name: "My experimental skills",
    origin: "custom",
    rootDir: "C:\\Users\\me\\skills",
    trusted: false,
    enabled: true,
    registeredInPathPolicy: false,
    createdAt: "2026-05-12T00:00:00.000Z",
    updatedAt: "2026-05-12T00:00:00.000Z",
  };
  assert.equal(isSkillSource(src), true);
});

test("isSkillSource rejects bad origin", () => {
  const src = {
    id: "ss_x",
    name: "x",
    origin: "weird",
    rootDir: "/tmp",
    trusted: false,
    enabled: true,
    registeredInPathPolicy: false,
    createdAt: "2026-05-12T00:00:00.000Z",
    updatedAt: "2026-05-12T00:00:00.000Z",
  };
  assert.equal(isSkillSource(src), false);
});

test("isSkillSource rejects empty rootDir", () => {
  const src = {
    id: "ss_x",
    name: "x",
    origin: "custom",
    rootDir: "",
    trusted: false,
    enabled: true,
    registeredInPathPolicy: false,
    createdAt: "2026-05-12T00:00:00.000Z",
    updatedAt: "2026-05-12T00:00:00.000Z",
  };
  assert.equal(isSkillSource(src), false);
});

test("isSkillSource rejects non-boolean trusted/enabled", () => {
  const base = {
    id: "ss_x",
    name: "x",
    origin: "custom",
    rootDir: "/tmp/skills",
    trusted: false,
    enabled: true,
    registeredInPathPolicy: false,
    createdAt: "2026-05-12T00:00:00.000Z",
    updatedAt: "2026-05-12T00:00:00.000Z",
  };
  assert.equal(isSkillSource({ ...base, trusted: "yes" }), false);
  assert.equal(isSkillSource({ ...base, enabled: 1 }), false);
});
