import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  listSkillResources,
  loadSkills,
  parseSkillFrontmatter,
  readSkillInstructions,
} from "./skill-loader.ts";

const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), "hgos-skill-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
};

test("parseSkillFrontmatter reads name, description, risk, triggers", () => {
  const file = {
    path: "/x/SKILL.md",
    dir: "/x",
    content: [
      "---",
      "name: Refactor Helper",
      "description: Suggests safe refactors",
      "risk: medium",
      "version: 1.2.3",
      "author: Harness",
      "license: MIT",
      "allowedActions:",
      "  - file_write",
      "requiredApprovals: [file_write, shell]",
      "triggerTerms: [refactor, rename, extract]",
      "tags: [code, safe]",
      "platforms: [windows, linux]",
      "inputs: [source]",
      "outputs: [patch]",
      "relatedSkills: [review-helper]",
      "projectScopes: [HarnessAgentOS]",
      "references: [notes.md]",
      "---",
      "",
      "# Body",
    ].join("\n"),
  };
  const parsed = parseSkillFrontmatter(file);
  assert.equal(parsed.name, "Refactor Helper");
  assert.equal(parsed.description, "Suggests safe refactors");
  assert.equal(parsed.version, "1.2.3");
  assert.equal(parsed.author, "Harness");
  assert.equal(parsed.license, "MIT");
  assert.equal(parsed.riskLevel, "medium");
  assert.deepEqual(parsed.allowedActions, ["file_write"]);
  assert.deepEqual(parsed.requiredApprovals, ["file_write", "shell"]);
  assert.deepEqual(parsed.triggerTerms, ["refactor", "rename", "extract"]);
  assert.deepEqual(parsed.tags, ["code", "safe"]);
  assert.deepEqual(parsed.platforms, ["windows", "linux"]);
  assert.deepEqual(parsed.inputs, ["source"]);
  assert.deepEqual(parsed.outputs, ["patch"]);
  assert.deepEqual(parsed.relatedSkills, ["review-helper"]);
  assert.deepEqual(parsed.projectScopes, ["HarnessAgentOS"]);
  assert.deepEqual(parsed.resources.references, ["notes.md"]);
  assert.match(parsed.id, /^cap_/);
});

test("loadSkills discovers SKILL.md files in trusted root", async () => {
  const t = tmp();
  try {
    const skillDir = join(t.dir, "refactor");
    mkdirSync(skillDir);
    writeFileSync(
      join(skillDir, "SKILL.md"),
      [
        "---",
        "name: refactor",
        "description: r",
        "risk: low",
        "triggerTerms: [refactor]",
        "---",
        "body",
      ].join("\n"),
    );
    const skills = await loadSkills({ rootDir: t.dir, trusted: true });
    assert.equal(skills.length, 1);
    assert.equal(skills[0].name, "refactor");
    assert.equal(skills[0].trusted, true);
    assert.deepEqual(skills[0].requiredApprovals, []);
    assert.deepEqual(skills[0].platforms, ["any"]);
  } finally {
    t.cleanup();
  }
});

test("loadSkills skips skills with unsupported approval actions", async () => {
  const t = tmp();
  try {
    const skillDir = join(t.dir, "bad-action");
    mkdirSync(skillDir);
    writeFileSync(
      join(skillDir, "SKILL.md"),
      [
        "---",
        "name: bad",
        "description: unsupported",
        "allowedActions: [git_push]",
        "---",
        "body",
      ].join("\n"),
    );
    const skills = await loadSkills({ rootDir: t.dir, trusted: true });
    assert.deepEqual(skills, []);
  } finally {
    t.cleanup();
  }
});

test("loadSkills returns empty when root does not exist", async () => {
  const skills = await loadSkills({
    rootDir: join(tmpdir(), "definitely-not-here-" + Math.random()),
    trusted: true,
  });
  assert.deepEqual(skills, []);
});

test("untrusted skills get medium risk floor even when declared low", async () => {
  const t = tmp();
  try {
    const skillDir = join(t.dir, "noisy");
    mkdirSync(skillDir);
    writeFileSync(
      join(skillDir, "SKILL.md"),
      [
        "---",
        "name: noisy",
        "description: x",
        "risk: low",
        "triggerTerms: [x]",
        "---",
        "",
      ].join("\n"),
    );
    const skills = await loadSkills({ rootDir: t.dir, trusted: false });
    assert.equal(skills.length, 1);
    assert.equal(skills[0].riskLevel, "medium");
    assert.equal(skills[0].trusted, false);
  } finally {
    t.cleanup();
  }
});

test("readSkillInstructions reads SKILL.md content", async () => {
  const t = tmp();
  try {
    const skillDir = join(t.dir, "refactor");
    mkdirSync(skillDir);
    writeFileSync(
      join(skillDir, "SKILL.md"),
      [
        "---",
        "name: refactor",
        "description: d",
        "---",
        "Hello",
      ].join("\n"),
    );
    const skills = await loadSkills({ rootDir: t.dir, trusted: true });
    const meta = skills[0];
    const text = await readSkillInstructions(meta);
    assert.match(text, /Hello/);
  } finally {
    t.cleanup();
  }
});

test("listSkillResources returns conventional resource manifests including references", async () => {
  const t = tmp();
  try {
    const skillDir = join(t.dir, "refactor");
    mkdirSync(skillDir);
    mkdirSync(join(skillDir, "scripts"));
    mkdirSync(join(skillDir, "templates"));
    mkdirSync(join(skillDir, "examples"));
    mkdirSync(join(skillDir, "references"));
    writeFileSync(
      join(skillDir, "SKILL.md"),
      ["---", "name: refactor", "description: d", "---", "Hello"].join("\n"),
    );
    writeFileSync(join(skillDir, "scripts", "run.mjs"), "");
    writeFileSync(join(skillDir, "templates", "prompt.md"), "");
    writeFileSync(join(skillDir, "examples", "case.md"), "");
    writeFileSync(join(skillDir, "references", "notes.md"), "");
    const skills = await loadSkills({ rootDir: t.dir, trusted: true });
    const resources = await listSkillResources(skills[0]);
    assert.deepEqual(resources, {
      scripts: ["run.mjs"],
      templates: ["prompt.md"],
      examples: ["case.md"],
      references: ["notes.md"],
    });
  } finally {
    t.cleanup();
  }
});
