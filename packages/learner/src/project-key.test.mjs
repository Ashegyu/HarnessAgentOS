import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveProjectKey, projectKeyFromParts } from "./project-key.ts";

test("projectKeyFromParts is stable and removes remote credentials", () => {
  const a = projectKeyFromParts({
    targetDir: "C:\\Repo\\HarnessAgentOS\\",
    remoteUrl: "https://user:secret@example.com/Org/Repo.git",
  });
  const b = projectKeyFromParts({
    targetDir: "c:/repo/harnessagentos",
    remoteUrl: "https://example.com/Org/Repo.git",
  });
  assert.equal(a, b);
  assert.match(a, /^proj_[a-f0-9]{16}$/);
});

test("deriveProjectKey reads origin remote from .git/config when present", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hgos-project-key-"));
  try {
    mkdirSync(join(dir, ".git"));
    writeFileSync(
      join(dir, ".git", "config"),
      `[remote "origin"]\n  url = https://example.com/acme/repo.git\n`,
    );
    const key = await deriveProjectKey({ targetDir: dir });
    assert.match(key, /^proj_[a-f0-9]{16}$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
