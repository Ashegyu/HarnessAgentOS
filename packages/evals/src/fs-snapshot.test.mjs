import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  allChangesInside,
  diffSnapshots,
  snapshotTree,
} from "./fs-snapshot.ts";

test("snapshotTree and diffSnapshots track added modified and removed files", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "hgos-fs-snapshot-"));
  try {
    await writeFile(path.join(root, "keep.txt"), "old\n", "utf8");
    await writeFile(path.join(root, "remove.txt"), "bye\n", "utf8");
    const before = await snapshotTree(root);

    await writeFile(path.join(root, "keep.txt"), "new\n", "utf8");
    await writeFile(path.join(root, "add.txt"), "add\n", "utf8");
    await unlink(path.join(root, "remove.txt"));
    const after = await snapshotTree(root);

    const diff = diffSnapshots(before, after);
    assert.deepEqual(diff.added, ["add.txt"]);
    assert.deepEqual(diff.modified, ["keep.txt"]);
    assert.deepEqual(diff.removed, ["remove.txt"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("allChangesInside rejects changes outside the allowed root", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "hgos-fs-boundary-"));
  try {
    const allowed = path.join(root, "allowed");
    await mkdir(allowed, { recursive: true });
    const before = await snapshotTree(root);

    await writeFile(path.join(allowed, "inside.txt"), "ok\n", "utf8");
    await writeFile(path.join(root, "outside.txt"), "escape\n", "utf8");
    const after = await snapshotTree(root);

    const diff = diffSnapshots(before, after);
    assert.equal(allChangesInside(diff, root, allowed), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
