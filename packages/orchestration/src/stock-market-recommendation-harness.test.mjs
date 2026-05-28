import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";
import { isHarnessDefinition } from "@harness/core";
import { importHarnessPackageFromDirectory } from "./harness-directory-import.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../../..");
const HARNESS_ROOT = resolve(
  REPO_ROOT,
  "docs/harnesses/stock-market-recommendation",
);
const IMPORTED_AT = "2026-05-28T00:00:00.000Z";

test("stock market recommendation harness imports as a native package", async () => {
  const result = await importHarnessPackageFromDirectory({
    rootDir: HARNESS_ROOT,
    importedAt: IMPORTED_AT,
  });

  assert.equal(result.ok, true);
  assert.equal(result.definition.source.format, "harness-native");
  assert.equal(result.definition.name, "Stock Market Recommendation System Harness");
  assert.equal(result.definition.agents.length, 4);
  assert.equal(result.definition.skills.length, 1);
  assert.equal(result.definition.workflows.length, 1);
  assert.equal(result.definition.workflows[0].steps.length, 5);
  assert.equal(result.definition.validation.status, "needs_review");
  assert.equal(
    result.definition.validation.issues.some(
      (issue) => issue.code === "HARNESS_PROFILE_BINDING_REQUIRED",
    ),
    true,
  );
  assert.equal(isHarnessDefinition(result.definition), true);
});

test("stock market recommendation native manifest declares network and risk controls", async () => {
  const content = await readFile(
    resolve(HARNESS_ROOT, ".harness/manifest.json"),
    "utf8",
  );
  const manifest = JSON.parse(content);

  assert.equal(manifest.schema, "harness.agentos.package.v1");
  assert.equal(manifest.package.id, "stock-market-recommendation-system");
  assert.deepEqual(
    manifest.package.capabilities.map((item) => item.id).sort(),
    [
      "financial-news-web-search",
      "macro-economic-data-api",
      "market-data-api",
      "recommendation-report-file-write",
    ],
  );
  assert.equal(manifest.package.safetyPolicy.noTradeExecution, true);
  assert.equal(manifest.package.safetyPolicy.personalizedAdvice, false);
});
