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
  assert.ok(Buffer.byteLength(packed.section, "utf8") <= 1_200);
  assert.ok(packed.section.includes("[...repo context truncated]"));
});

for (const text of ["한글 저장소 설명", "🙂🚢한글", 'ASCII\\path "quoted"']) {
  test(`context UTF-8 budget includes the truncation marker for ${text}`, () => {
    const packed = packRepoContext({ prompt: "large", maxBytes: 1200,
      files: Array.from({ length: 8 }, (_, i) => file(`src/large-${i}.ts`, { summary: text.repeat(200) })) });
    assert.ok(Buffer.byteLength(packed.section, "utf8") <= 1200);
    assert.match(packed.section, /\[\.\.\.repo context truncated\]$/);
    assert.equal(Buffer.from(packed.section, "utf8").toString("utf8"), packed.section);
  });
}

test("explicit small budgets are hard caps rather than an implicit 1024-byte minimum", () => {
  for (const maxBytes of [0, 1, 2, 3, 10, 25, 26, 27, 28, 80, 1023, 1201]) {
    const packed = packRepoContext({ prompt: "", files: [file("한글🙂.ts", { summary: "한글🙂".repeat(500) })], maxBytes });
    assert.ok(Buffer.byteLength(packed.section, "utf8") <= maxBytes, `budget=${maxBytes}`);
    assert.equal(Buffer.from(packed.section).toString(), packed.section);
  }
});

test("summary boundaries do not split a surrogate pair even when the section fits", () => {
  const packed = packRepoContext({ prompt: "", files: [file("src/emoji.ts", { summary: "x".repeat(499) + "🙂 tail" })] });
  assert.equal(Buffer.from(packed.section).toString(), packed.section);
});

test("invalid byte budgets are rejected and fractional budgets are rounded down", () => {
  for (const maxBytes of [NaN, Infinity, -1]) assert.throws(() => packRepoContext({ prompt: "", files: [], maxBytes }), RangeError);
  const packed = packRepoContext({ prompt: "", files: [], maxBytes: 40.9 });
  assert.ok(Buffer.byteLength(packed.section) <= 40);
});
