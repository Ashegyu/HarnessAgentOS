import { test } from "node:test";
import assert from "node:assert/strict";
import {
  primaryHarnessPackageIssue,
  summarizeHarnessPackage,
} from "./harness-package-ui.ts";

const pkg = (overrides = {}) => ({
  id: "harness_demo",
  name: "Demo Harness",
  source: {
    format: "codex",
    rootDir: "C:/tmp/demo",
    importedAt: "2026-05-27T00:00:00.000Z",
    files: [
      {
        relativePath: "skills/demo/SKILL.md",
        kind: "skill",
        sha256: "abc",
        parserVersion: "test",
      },
    ],
  },
  overview: { title: "Demo Harness", summary: "Demo" },
  agents: [],
  skills: [
    {
      id: "demo",
      name: "demo",
      description: "Demo skill",
      triggerTerms: [],
      negativeTriggerTerms: [],
      sourceFile: "skills/demo/SKILL.md",
      workflowRefs: [],
      relatedSkillRefs: [],
      rawFrontmatter: {},
    },
  ],
  workflows: [],
  capabilities: [],
  validation: {
    status: "needs_review",
    issues: [
      {
        severity: "warning",
        code: "HARNESS_WORKFLOW_PARSE_PENDING",
        message: "Workflow parse pending",
        blocksExecution: true,
      },
      {
        severity: "info",
        code: "HARNESS_NOTE",
        message: "Metadata imported",
        blocksExecution: false,
      },
    ],
    importedAt: "2026-05-27T00:00:00.000Z",
    adapterVersion: "test",
  },
  ...overrides,
});

test("summarizeHarnessPackage counts package structure and blocking issues", () => {
  const summary = summarizeHarnessPackage(pkg());

  assert.equal(summary.formatLabel, "Codex");
  assert.equal(summary.statusLabel, "Needs review");
  assert.equal(summary.files, 1);
  assert.equal(summary.skills, 1);
  assert.equal(summary.workflows, 0);
  assert.deepEqual(summary.issueCounts, {
    info: 1,
    warning: 1,
    error: 0,
  });
  assert.equal(summary.blocksExecution, true);
});

test("primaryHarnessPackageIssue prefers execution blockers", () => {
  const issue = primaryHarnessPackageIssue(
    pkg({
      validation: {
        ...pkg().validation,
        issues: [
          {
            severity: "info",
            code: "INFO",
            message: "First",
            blocksExecution: false,
          },
          {
            severity: "error",
            code: "BLOCKED",
            message: "Second",
            blocksExecution: true,
          },
        ],
      },
    }),
  );

  assert.equal(issue.code, "BLOCKED");
});

test("primaryHarnessPackageIssue returns null with no issues", () => {
  const issue = primaryHarnessPackageIssue(
    pkg({
      validation: { ...pkg().validation, issues: [], status: "valid" },
    }),
  );

  assert.equal(issue, null);
});
