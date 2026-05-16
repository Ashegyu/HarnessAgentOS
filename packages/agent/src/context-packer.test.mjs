import { test } from "node:test";
import assert from "node:assert/strict";
import { packRepoContext } from "./context-packer.ts";

const file = (relativePath, patch = {}) => ({
  id: `repoidx_${relativePath}`,
  projectKey: "project",
  targetDir: "/tmp/project",
  relativePath,
  fileKind: "source",
  sizeBytes: 100,
  mtimeMs: 1,
  contentHash: "hash",
  summary: "",
  symbols: [],
  imports: [],
  updatedAt: "2026-05-16T00:00:00.000Z",
  ...patch,
});

test("packRepoContext pins package/config files and ranks prompt matches", () => {
  const packed = packRepoContext({
    prompt: "fix approval panel shadow preview",
    files: [
      file("src/unrelated.ts", { summary: "nothing" }),
      file("package.json", { fileKind: "package", summary: "package demo" }),
      file("src/ApprovalPanel.tsx", {
        summary: "approval panel shadow preview button",
        symbols: ["ApprovalPanel"],
      }),
    ],
    maxFiles: 2,
  });
  assert.deepEqual(packed.selectedFiles, ["package.json", "src/ApprovalPanel.tsx"]);
  assert.ok(packed.section.includes("REPOSITORY CONTEXT"));
  assert.ok(packed.section.includes("ApprovalPanel"));
});

test("packRepoContext respects maxBytes", () => {
  const packed = packRepoContext({
    prompt: "large",
    files: Array.from({ length: 8 }, (_, index) =>
      file(`src/large-${index}.ts`, { summary: "x".repeat(10_000) }),
    ),
    maxBytes: 1_200,
  });
  assert.ok(Buffer.byteLength(packed.section, "utf8") <= 1_240);
  assert.ok(packed.section.includes("[...repo context truncated]"));
});
