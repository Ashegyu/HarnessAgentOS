import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveWindowsCommand, decodeCommandOutput, simpleNpmArgs } from './windows-command.ts';

test('npm.cmd resolves to a verified node + npm-cli.js without shell interpolation', t => {
  const dir = mkdtempSync(join(tmpdir(), 'hgos-cli-한글 '));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'node_modules/npm/bin'), { recursive: true });
  for (const name of ['node.exe', 'npm.cmd', 'node_modules/npm/bin/npm-cli.js']) writeFileSync(join(dir, name), 'fixture');
  const args = ['run', 'test', '--', '한글 공백', '"quote"', '& echo unsafe', '%PATH%', '!x!'];
  const result = resolveWindowsCommand(join(dir, 'npm.cmd'), args, { Path: dir });
  assert.equal(result.command, join(dir, 'node.exe'));
  assert.deepEqual(result.args, [join(dir, 'node_modules/npm/bin/npm-cli.js'), ...args]);
  assert.deepEqual(resolveWindowsCommand('npm',args,{Path:dir}),result);
  assert.deepEqual(resolveWindowsCommand('npm',args,{HARNESS_NODE_PATH:join(dir,'node.exe'),HARNESS_NPM_CLI_PATH:join(dir,'node_modules/npm/bin/npm-cli.js')}),result);
});

test('unknown batch files are rejected rather than passed unescaped to cmd', () => {
  assert.throws(() => resolveWindowsCommand('other.cmd', ['&echo unsafe'], {}), /BATCH/);
});

test('Windows Korean diagnostics decode CP949 while preserving valid UTF-8', () => {
  assert.equal(decodeCommandOutput(Buffer.from([0xc7,0xd1,0xb1,0xdb])), '한글');
  assert.equal(decodeCommandOutput(Buffer.from('한글 UTF-8')), '한글 UTF-8');
  assert.equal(decodeCommandOutput(Buffer.from([0xff,0xfe,0x5c,0xd5,0x00,0xae])), '한글');
});

test('simple npm command parsing preserves quoted arguments and leaves shell syntax explicit', () => {
  assert.deepEqual(simpleNpmArgs('npm run "한글 공백"'), {command:'npm',args:['run','한글 공백']});
  assert.deepEqual(simpleNpmArgs('npx --version'), {command:'npx',args:['--version']});
  for (const command of ['npm test && echo unsafe','npm test > output','npm "unterminated','node --version','npm %PATH%']) assert.equal(simpleNpmArgs(command),null);
});

test('missing npm runtime fails with setup guidance; ordinary executable argv is unchanged', () => {
  assert.throws(()=>resolveWindowsCommand('npm',[],{}),/CLI_NOT_FOUND/);
  assert.throws(()=>resolveWindowsCommand('npm',[],{HARNESS_NODE_PATH:'C:/does-not-exist.exe'}),/CLI_NOT_FOUND/);
  assert.deepEqual(resolveWindowsCommand('git',['--version'],{}),{command:'git',args:['--version']});
});
