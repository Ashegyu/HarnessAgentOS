import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
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
      "allowedActions:",
      "  - file_write",
      "triggerTerms: [refactor, rename, extract]",
      "---",
      "",
      "# Body",
    ].join("\n"),
  };
  const parsed = parseSkillFrontmatter(file);
  assert.equal(parsed.name, "Refactor Helper");
  assert.equal(parsed.description, "Suggests safe refactors");
  assert.equal(parsed.riskLevel, "medium");
  assert.deepEqual(parsed.allowedActions, ["file_write"]);
  assert.deepEqual(parsed.triggerTerms, ["refactor", "rename", "extract"]);
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
