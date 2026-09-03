import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileRunner, FileRunnerError } from "./file-runner.ts";

const tempWorkspace = () => {
  const root = mkdtempSync(join(tmpdir(), "hgos-file-runner-"));
  const workspace = join(root, "workspace");
  const outside = join(root, "outside");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(outside, { recursive: true });
  return {
    root,
    workspace,
    outside,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
};

test("FileRunner rejects a junction or directory symlink that escapes targetDir", async () => {
  const t = tempWorkspace();
  try {
    const linkPath = join(t.workspace, "linked-outside");
    symlinkSync(t.outside, linkPath, process.platform === "win32" ? "junction" : "dir");

    await assert.rejects(
      new FileRunner().run({
        targetDir: t.workspace,
        patch: { path: "linked-outside/escaped.txt", after: "blocked" },
      }),
      (error) =>
        error instanceof FileRunnerError &&
        error.code === "RUNNER_TARGET_OUTSIDE_WORKSPACE",
    );
    assert.equal(existsSync(join(t.outside, "escaped.txt")), false);
  } finally {
    t.cleanup();
  }
});

test("FileRunner rejects a stale proposed before value", async () => {
  const t = tempWorkspace();
  try {
    const target = join(t.workspace, "src.txt");
    writeFileSync(target, "newer user content", "utf8");

    await assert.rejects(
      new FileRunner().run({
        targetDir: t.workspace,
        patch: {
          path: "src.txt",
          before: "older approved content",
          after: "agent replacement",
        },
      }),
      (error) =>
        error instanceof FileRunnerError &&
        error.code === "RUNNER_FILE_CONTENT_CHANGED",
    );
    assert.equal(readFileSync(target, "utf8"), "newer user content");
  } finally {
    t.cleanup();
  }
});

test("FileRunner still creates a safe nested file", async () => {
  const t = tempWorkspace();
  try {
    const result = await new FileRunner().run({
      targetDir: t.workspace,
      patch: { path: "nested/safe.txt", after: "safe" },
    });
    assert.equal(readFileSync(result.path, "utf8"), "safe");
  } finally {
    t.cleanup();
  }
});
