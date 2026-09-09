import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FileDeleteRunner, inspectDeleteFile } from './file-delete-runner.ts';

const setup = t => {
  const dir = mkdtempSync(join(tmpdir(), 'hgos-trash-'));
  mkdirSync(join(dir, 'target'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'target', '한글.txt'), 'old');
  return { dir, target: join(dir, 'target') };
};

test('single-file trash passes the exact approved file to the host adapter', async t => {
  const f = setup(t);
  const snapshot = await inspectDeleteFile(f.target, '한글.txt');
  let trashed;
  await new FileDeleteRunner(async path => { trashed = path; }).run(f.target, snapshot);
  assert.equal(trashed, join(f.target, '한글.txt'));
});

test('trash failure never falls back to permanent unlink', async t => {
  const f = setup(t);
  const snapshot = await inspectDeleteFile(f.target, '한글.txt');
  await assert.rejects(new FileDeleteRunner(async () => { throw new Error('trash unavailable'); }).run(f.target, snapshot), /trash unavailable/);
  assert.equal(existsSync(join(f.target, '한글.txt')), true);
});

test('changed content after preparation/approval requires another review', async t => {
  const f = setup(t);
  const snapshot = await inspectDeleteFile(f.target, '한글.txt');
  writeFileSync(join(f.target, '한글.txt'), 'new');
  let calls = 0;
  await assert.rejects(new FileDeleteRunner(async () => { calls++; }).run(f.target, snapshot), /CHANGED/);
  assert.equal(calls, 0);
});

test('directories, .git, roots, wildcards, missing files, alternate streams, and parent traversal are rejected', async t => {
  const f = setup(t);
  mkdirSync(join(f.target, '.git'));
  writeFileSync(join(f.target, '.git/config'), 'keep');
  for (const path of ['.', '..', '../other.txt', '.git/config', '*.txt', '한글.txt:stream', 'missing.txt', 'C:/']) {
    await assert.rejects(inspectDeleteFile(f.target, path));
  }
});

test('junctions cannot redirect a delete outside or inside the task target', async t => {
  const f = setup(t);
  mkdirSync(join(f.dir, 'outside'));
  writeFileSync(join(f.dir, 'outside/keep.txt'), 'keep');
  symlinkSync(join(f.dir, 'outside'), join(f.target, 'link'), 'junction');
  await assert.rejects(inspectDeleteFile(f.target, 'link/keep.txt'), /PATH|LINK/);
  assert.equal(existsSync(join(f.dir, 'outside/keep.txt')), true);
});
