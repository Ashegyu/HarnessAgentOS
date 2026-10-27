import { test, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import childProcess from "node:child_process";
import { chmodSync, mkdtempSync, readdirSync, rmSync, mkdirSync, writeFileSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const loadCapture = async () => {
  const module = await import("./workspace-validation-revision.ts").catch(() => null);
  assert.equal(typeof module?.captureValidationRevision, "function", "complete validation revisions must be available instead of advisory size/mtime snapshots");
  return module.captureValidationRevision;
};
const fixture = t => {
  const root = mkdtempSync(join(tmpdir(), "hgos-validation-revision-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
};
const gitFixture = t => {
  const base = join(process.cwd(), ".cache", "quality-revision-fixtures");
  mkdirSync(base, { recursive: true });
  const root = mkdtempSync(join(base, "git-"));
  t.after(() => {
    assert.ok(resolve(root).startsWith(resolve(base)));
    const writable = directory => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) writable(path);
        else chmodSync(path, 0o600);
      }
    };
    writable(root);
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  return root;
};
const git = (root, ...args) => childProcess.execFileSync("git", ["-C", root, ...args], { stdio: "pipe", windowsHide: true });

test("complete validation revisions are stable and use canonical workspace identity", async t => {
  const capture = await loadCapture();
  const root = fixture(t);
  writeFileSync(join(root, "source.txt"), "hello");
  const first = await capture(root);
  const second = await capture(join(root, "."));
  assert.match(first.fingerprint, /^[a-f0-9]{64}$/);
  assert.deepEqual(second, first);
  const canonical = await fs.realpath(root);
  assert.equal(first.workspaceKey, process.platform === "win32" ? canonical.toLowerCase() : canonical);
});

test("same-size content edits remain visible when mtime is restored", async t => {
  const capture = await loadCapture();
  const root = fixture(t);
  const file = join(root, "source.txt");
  writeFileSync(file, "AAAA");
  const before = await capture(root);
  const old = statSync(file);
  writeFileSync(file, "BBBB");
  utimesSync(file, old.atime, old.mtime);
  const after = await capture(root);
  assert.ok(before.fingerprint && after.fingerprint);
  assert.notEqual(after.fingerprint, before.fingerprint);
});

test("ordinary edit then content restoration still advances the input identity", async t => {
  const capture = await loadCapture();
  const root = fixture(t);
  const file = join(root, "source.txt");
  writeFileSync(file, "original");
  const before = await capture(root);
  const old = statSync(file);
  await new Promise(resolve => setImmediate(resolve));
  writeFileSync(file, "temporary");
  writeFileSync(file, "original");
  utimesSync(file, old.atime, old.mtime);
  const after = await capture(root);
  assert.ok(after.fingerprint);
  assert.notEqual(after.fingerprint, before.fingerprint);
});

test("Git tracked source in output-named directories is included", async t => {
  const capture = await loadCapture();
  const root = gitFixture(t);
  git(root, "init", "-q");
  mkdirSync(join(root, "build"));
  writeFileSync(join(root, "build", "source.ts"), "export const x = 1;");
  writeFileSync(join(root, ".gitignore"), "build/\n");
  git(root, "add", ".gitignore");
  git(root, "add", "-f", "build/source.ts");
  const before = await capture(root);
  writeFileSync(join(root, "build", "source.ts"), "export const x = 2;");
  const after = await capture(root);
  assert.ok(before.fingerprint && after.fingerprint);
  assert.notEqual(after.fingerprint, before.fingerprint);
});

test("Git scope excludes ignored generated files but includes new untracked inputs", async t => {
  const capture = await loadCapture();
  const root = gitFixture(t);
  git(root, "init", "-q");
  writeFileSync(join(root, ".gitignore"), "generated/\n");
  writeFileSync(join(root, "source.txt"), "source");
  const before = await capture(root);
  mkdirSync(join(root, "generated"));
  writeFileSync(join(root, "generated", "result.txt"), "generated");
  assert.deepEqual(await capture(root), before);
  writeFileSync(join(root, "new-source.txt"), "new");
  assert.notEqual((await capture(root)).fingerprint, before.fingerprint);
});

test("a stable tracked-file deletion is part of the current revision", async t => {
  const capture = await loadCapture();
  const root = gitFixture(t);
  git(root, "init", "-q");
  const file = join(root, "source.txt");
  writeFileSync(file, "tracked");
  git(root, "add", "source.txt");
  const before = await capture(root);
  await fs.unlink(file);
  const deleted = await capture(root);
  assert.ok(deleted.fingerprint, "an intentional tracked deletion is a verifiable input state");
  assert.notEqual(deleted.fingerprint, before.fingerprint);
  assert.deepEqual(await capture(root), deleted);
});

test("a pre-aborted capture does not start Git or file-content reads", async t => {
  const capture = await loadCapture();
  const root = fixture(t);
  writeFileSync(join(root, "source.txt"), "source");
  const controller = new AbortController();
  controller.abort();
  let gitCalls = 0;
  let reads = 0;
  const originalExec = childProcess.execFile;
  const originalOpen = fs.open;
  const gitMock = mock.method(childProcess, "execFile", (...args) => { gitCalls++; return originalExec(...args); });
  const readMock = mock.method(fs, "open", (...args) => { reads++; return originalOpen(...args); });
  try {
    const revision = await capture(root, { signal: controller.signal });
    assert.equal(revision.fingerprint, null);
    assert.match(revision.reason, /cancel/);
    assert.equal(gitCalls, 0);
    assert.equal(reads, 0);
  } finally { gitMock.mock.restore(); readMock.mock.restore(); }
});

test("non-Git generated output policy does not exclude nested source build folders", async t => {
  const capture = await loadCapture();
  const root = fixture(t);
  mkdirSync(join(root, "src", "build"), { recursive: true });
  writeFileSync(join(root, "src", "build", "input.txt"), "source");
  const before = await capture(root);
  mkdirSync(join(root, "out"));
  writeFileSync(join(root, "out", "generated.txt"), "generated");
  assert.deepEqual(await capture(root), before);
  writeFileSync(join(root, "src", "build", "input.txt"), "changed");
  assert.notEqual((await capture(root)).fingerprint, before.fingerprint);
});

test("limits are unverifiable rather than metadata hash fallbacks", async t => {
  const capture = await loadCapture();
  const root = fixture(t);
  writeFileSync(join(root, "a.txt"), "1234");
  writeFileSync(join(root, "b.txt"), "5678");
  for (const options of [{ maxFiles: 1 }, { maxFileBytes: 3 }, { maxTotalBytes: 7 }]) {
    const revision = await capture(root, options);
    assert.equal(revision.fingerprint, null);
    assert.match(revision.reason, /limit/);
  }
});

test("missing, non-directory and relative roots cannot establish revisions", async t => {
  const capture = await loadCapture();
  const root = fixture(t);
  writeFileSync(join(root, "file.txt"), "file");
  for (const target of [join(root, "missing"), join(root, "file.txt"), "."]) {
    const revision = await capture(target);
    assert.equal(revision.fingerprint, null);
    assert.equal(typeof revision.reason, "string");
  }
});

test("read failures cannot turn into valid metadata-only revisions", async t => {
  const capture = await loadCapture();
  const root = fixture(t);
  const file = join(root, "private.txt");
  writeFileSync(file, "private");
  const original = fs.open;
  const mocked = mock.method(fs, "open", async (...args) => {
    if (resolve(args[0]) === resolve(file)) throw Object.assign(new Error("denied"), { code: "EACCES" });
    return original(...args);
  });
  try { assert.equal((await capture(root)).fingerprint, null); }
  finally { mocked.mock.restore(); }
});

test("a file changed between inventory and open invalidates the capture", async t => {
  const capture = await loadCapture();
  const root = fixture(t);
  const file = join(root, "source.txt");
  writeFileSync(file, "AAAA");
  const original = fs.open;
  let injected = false;
  const mocked = mock.method(fs, "open", async (...args) => {
    if (!injected && resolve(args[0]) === resolve(file)) { injected = true; writeFileSync(file, "BBBB"); }
    return original(...args);
  });
  try { assert.equal((await capture(root)).fingerprint, null); }
  finally { mocked.mock.restore(); }
});

test("new input appearing during hashing invalidates the capture", async t => {
  const capture = await loadCapture();
  const root = fixture(t);
  const file = join(root, "source.txt");
  writeFileSync(file, "source");
  const original = fs.open;
  let injected = false;
  const mocked = mock.method(fs, "open", async (...args) => {
    if (!injected && resolve(args[0]) === resolve(file)) { injected = true; writeFileSync(join(root, "late.txt"), "late"); }
    return original(...args);
  });
  try { assert.equal((await capture(root)).fingerprint, null); }
  finally { mocked.mock.restore(); }
});

test("known Git scope failure is unverifiable, never a plain-directory fallback", async t => {
  const capture = await loadCapture();
  const root = gitFixture(t);
  git(root, "init", "-q");
  writeFileSync(join(root, "source.txt"), "source");
  const original = childProcess.execFile;
  const mocked = mock.method(childProcess, "execFile", (...args) => {
    const callback = args.at(-1);
    queueMicrotask(() => callback(Object.assign(new Error("git unavailable"), { code: "ENOENT" }), "", ""));
    return { kill() {} };
  });
  try {
    const revision = await capture(root);
    assert.equal(revision.fingerprint, null);
    assert.match(revision.reason, /git/);
  } finally { mocked.mock.restore(); assert.equal(childProcess.execFile, original); }
});

test("ambiguous symbolic-link input is rejected before any content read", async t => {
  const capture = await loadCapture();
  const root = fixture(t);
  const file = join(root, "source.txt");
  writeFileSync(file, "source");
  const original = fs.lstat;
  const mocked = mock.method(fs, "lstat", async (...args) => {
    const info = await original(...args);
    if (resolve(args[0]) === resolve(file)) return Object.assign(Object.create(info), { isSymbolicLink: () => true });
    return info;
  });
  try { assert.equal((await capture(root)).fingerprint, null); }
  finally { mocked.mock.restore(); }
});

test("files larger than the advisory hash limit are still content hashed", async t => {
  const capture = await loadCapture();
  const root = fixture(t);
  const file = join(root, "large.txt");
  const bytes = Buffer.alloc(2 * 1024 * 1024, "A");
  writeFileSync(file, bytes);
  const before = await capture(root);
  bytes[bytes.length - 1] = 66;
  const old = statSync(file);
  writeFileSync(file, bytes);
  utimesSync(file, old.atime, old.mtime);
  const after = await capture(root);
  assert.ok(before.fingerprint && after.fingerprint);
  assert.notEqual(after.fingerprint, before.fingerprint);
});
