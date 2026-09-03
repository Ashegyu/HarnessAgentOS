import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildWorkspaceChangeEvidence,
  captureWorkspaceSnapshot,
} from "./workspace-change-tracker.ts";

test("workspace snapshots report added, modified, and deleted files", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-workspace-evidence-"));
  try {
    await mkdir(join(root, "src"));
    await writeFile(join(root, "README.md"), "before\n", "utf8");
    await writeFile(join(root, "src", "deleted.ts"), "old\n", "utf8");

    const before = await captureWorkspaceSnapshot(root);
    await writeFile(join(root, "README.md"), "after\n", "utf8");
    await unlink(join(root, "src", "deleted.ts"));
    await writeFile(join(root, "src", "added.ts"), "export const n = 1;\n", "utf8");
    const after = await captureWorkspaceSnapshot(root);

    const evidence = buildWorkspaceChangeEvidence(before, after);
    assert.deepEqual(
      evidence.changes.map(({ kind, relativePath }) => ({ kind, relativePath })),
      [
        { kind: "modified", relativePath: "README.md" },
        { kind: "added", relativePath: "src/added.ts" },
        { kind: "deleted", relativePath: "src/deleted.ts" },
      ],
    );
    assert.match(evidence.summary, /M README\.md/);
    assert.match(evidence.summary, /A src\/added\.ts/);
    assert.match(evidence.summary, /D src\/deleted\.ts/);
    assert.match(evidence.summary, /--- a\/README\.md/);
    assert.match(evidence.summary, /\+\+\+ b\/README\.md/);
    assert.match(evidence.summary, /-before/);
    assert.match(evidence.summary, /\+after/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("workspace evidence bounds captured text while retaining file metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-workspace-cap-"));
  try {
    await writeFile(join(root, "large.txt"), "a".repeat(64), "utf8");
    const before = await captureWorkspaceSnapshot(root, {
      maxFileContentBytes: 16,
      maxTotalContentBytes: 16,
    });
    await writeFile(join(root, "large.txt"), "b".repeat(64), "utf8");
    const after = await captureWorkspaceSnapshot(root, {
      maxFileContentBytes: 16,
      maxTotalContentBytes: 16,
    });

    const evidence = buildWorkspaceChangeEvidence(before, after);
    assert.equal(evidence.changes.length, 1);
    assert.equal(evidence.changes[0]?.relativePath, "large.txt");
    assert.match(evidence.summary, /content omitted/i);
    assert.ok(evidence.summary.length < 2_000);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
