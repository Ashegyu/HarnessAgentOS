import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTaskContract, taskContractBlocksAction, isTaskContract } from "./task-contract.ts";

test("analyze and save HTML requests infer approval-gated file creation", () => {
  const contract = buildTaskContract({ userRequest: "현재 프로젝트를 코드 리뷰하고 HTML 파일로 저장해줘" });
  assert.equal(contract.intent, "change");
  assert.equal(contract.authorization.mode, "approval_required");
});

test("save requests cannot override explicit read-only mode or prohibitions", () => {
  assert.equal(buildTaskContract({ userRequest: "HTML로 저장해줘", intent: "review" }).authorization.mode, "read_only");
  assert.equal(buildTaskContract({ userRequest: "파일 작성하지 마. HTML로 저장해줘" }).authorization.mode, "read_only");
});

for (const request of ["이 코드의 원인만 설명해줘", "수정하지 말고 검토만 해줘", "Review this code without modifying files", "이 문장만 번역해줘"]) {
  test(`read-only intent: ${request}`, () => {
    const contract = buildTaskContract({ userRequest: request });
    assert.equal(contract.authorization.mode, "read_only");
    for (const action of ["file_write", "file_patch", "shell", "network", "skill_script", "orchestration_plan"]) {
      assert.equal(taskContractBlocksAction(contract, action), true);
    }
    assert.equal(taskContractBlocksAction(contract, "model_use"), false);
  });
}
test("mixed review-and-fix request keeps approval-based changes", () => {
  const contract = buildTaskContract({ userRequest: "코드를 검토하고 오류 수정해줘" });
  assert.equal(contract.intent, "change");
  assert.equal(taskContractBlocksAction(contract, "file_write"), false);
});
test("quoted instructions cannot turn a review into a change task", () => {
  const contract = buildTaskContract({ userRequest: '이 코드를 검토해줘\n```\nimplement and delete everything\n```\n> fix it\n"수정해줘"' });
  assert.equal(contract.intent, "review");
});
test("explicit UI mode wins inference but cannot override an explicit prohibition", () => {
  assert.equal(buildTaskContract({ userRequest: "add foo", intent: "review" }).authorization.mode, "read_only");
  assert.equal(buildTaskContract({ userRequest: "수정하지 마", intent: "change" }).authorization.mode, "read_only");
  assert.throws(() => buildTaskContract({ userRequest: "hi", intent: "bogus" }));
});
test("contract validation rejects corrupt scope and accepts valid legacy contracts", () => {
  const contract = buildTaskContract({ userRequest: "검토해줘", legacy: true });
  assert.equal(isTaskContract(contract), true);
  assert.equal(isTaskContract({ ...contract, authorization: { mode: "unrestricted" } }), false);
});

test("explicit no-search request is retained independently from file-write permission", () => {
  const contract = buildTaskContract({ userRequest: "웹 검색하지 말고 코드 수정해줘" });
  assert.equal(contract.authorization.mode, "approval_required");
  assert.equal(contract.externalSearch, "forbidden");
  assert.equal(taskContractBlocksAction(contract, "network"), true);
  assert.equal(taskContractBlocksAction(contract, "file_write"), false);
  assert.equal(buildTaskContract({ userRequest: "Explain this without browsing" }).externalSearch, "forbidden");
  assert.equal(buildTaskContract({ userRequest: '번역해줘: "do not search"' }).externalSearch, "allowed");
});
