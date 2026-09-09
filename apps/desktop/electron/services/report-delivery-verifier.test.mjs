import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyReportDelivery } from "./report-delivery-verifier.ts";

const setup = async t => {
  const dir = await mkdtemp(join(tmpdir(), "harness-report-check-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const content = "<!doctype html><html lang='ko'><body>분석 보고서</body></html>";
  await writeFile(join(dir, "report.html"), content);
  const task = { id: "task", targetDir: dir, userRequest: "현재 프로젝트를 상세히 분석해서 HTML 파일로 저장해줘" };
  const approvals = [{ id: "a", taskRunId: "task", actionType: "file_write", status: "executed", executionState: "succeeded",
    actionRevision: 1, approvedRevision: 1, proposedAction: { type: "file_write", filePatch: { path: "report.html", after: content } } }];
  return { task, approvals, dir, content };
};

test("a report is accepted only after actual disk contents match the executed approval", async t => {
  const f = await setup(t);
  assert.equal(await verifyReportDelivery(f.task, f.approvals), true);
  await writeFile(join(f.dir, "report.html"), "changed after execution");
  assert.equal(await verifyReportDelivery(f.task, f.approvals), false);
});

test("missing files and unexecuted approvals never prove delivery", async t => {
  const f = await setup(t);
  assert.equal(await verifyReportDelivery(f.task, []), false);
  assert.equal(await verifyReportDelivery(f.task, [{ ...f.approvals[0], status: "approved" }]), false);
  await rm(join(f.dir, "report.html"));
  assert.equal(await verifyReportDelivery(f.task, f.approvals), false);
});

test("code changes cannot be treated as report-only delivery", async t => {
  const f = await setup(t);
  for (const userRequest of ["HTML 앱 버그 수정하고 보고서를 저장해줘", "Implement a website and save an HTML report", "분석 보고서를 저장해줘\n> HTML 파일로 저장해줘"]) {
    assert.equal(await verifyReportDelivery({ ...f.task, userRequest }, f.approvals), false);
  }
  assert.equal(await verifyReportDelivery(f.task, [...f.approvals, { ...f.approvals[0], actionType: "shell" }]), false);
});

test("a path outside the workspace cannot establish report delivery", async t => {
  const f = await setup(t);
  const outside = await mkdtemp(join(tmpdir(), "harness-report-outside-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(join(outside, "report.html"), f.content);
  const row = { ...f.approvals[0], proposedAction: { type: "file_write", filePatch: { path: join(outside, "report.html"), after: f.content } } };
  assert.equal(await verifyReportDelivery(f.task, [row]), false);
  await symlink(outside, join(f.dir, "linked"), "junction");
  row.proposedAction.filePatch.path = "linked/report.html";
  assert.equal(await verifyReportDelivery(f.task, [row]), false);
});
