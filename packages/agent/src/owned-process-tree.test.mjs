import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { terminateWindowsProcessTree } from "./owned-process-tree.ts";

test("tree cleanup uses a single owned PID, no shell, no image wildcard, and bounded hidden taskkill", async () => {
  let call;
  await terminateWindowsProcessTree(12345, (command, args, options, callback) => {
    call = { command, args, options };
    callback(null);
  });
  assert.match(call.command, /^[A-Za-z]:\\.*\\System32\\taskkill\.exe$/i);
  assert.deepEqual(call.args, ["/PID", "12345", "/T", "/F"]);
  assert.equal(call.options.shell, false);
  assert.equal(call.options.windowsHide, true);
  assert.equal(call.options.timeout, 10_000);
  assert.equal(call.options.maxBuffer, 65_536);
});

test("tree cleanup rejects invalid PID and reports unconfirmed failures", async () => {
  for (const pid of [0, -1, 1.5, NaN, Infinity, process.pid, "12345 /IM *"]) {
    await assert.rejects(terminateWindowsProcessTree(pid, () => assert.fail("must not execute")), /Refusing/);
  }
  await assert.rejects(terminateWindowsProcessTree(12345, (_command, _args, _options, callback) => {
    callback(new Error("private diagnostic"));
  }), /could not be confirmed/);
});

test("Windows tree cleanup stops an owned child and grandchild but leaves an unrelated same-name process running", {
  skip: process.platform !== "win32", timeout: 15_000,
}, async () => {
  const args = ["-e", "setInterval(() => {}, 1000); setTimeout(() => process.exit(0), 12000);"];
  const sibling = spawn(process.execPath, args, { stdio: "ignore", windowsHide: true });
  const siblingClosed = once(sibling, "close");
  const script = `const {spawn}=require('node:child_process');
    const child=spawn(process.execPath,${JSON.stringify(args)},{stdio:'ignore',windowsHide:true});
    child.on('spawn',()=>process.stdout.write(String(child.pid)+'\\n'));
    setTimeout(()=>process.exit(0),12000);`;
  const root = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
  const rootClosed = once(root, "close");
  let grandchildPid;
  try {
    const [chunk] = await once(root.stdout, "data", { signal: AbortSignal.timeout(5_000) });
    grandchildPid = Number(chunk.toString().trim());
    assert.ok(Number.isSafeInteger(grandchildPid) && grandchildPid > 0);
    await terminateWindowsProcessTree(root.pid);
    await rootClosed;
    assert.throws(() => process.kill(grandchildPid, 0), { code: "ESRCH" });
    assert.equal(process.kill(sibling.pid, 0), true);
  } finally {
    if (root.exitCode === null && root.signalCode === null) root.kill("SIGKILL");
    if (grandchildPid) { try { process.kill(grandchildPid, "SIGKILL"); } catch {} }
    sibling.kill("SIGKILL");
    await Promise.all([rootClosed, siblingClosed]);
  }
});
