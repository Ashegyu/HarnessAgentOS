import { test } from "node:test";
import assert from "node:assert/strict";
import { ConversationStartService } from "./conversation-start-service.ts";
import { copyAnswerText } from "./clipboard-service.ts";
import { buildTaskContract } from "@harness/core";

for (const input of [
  { userRequest: "코드 리뷰만 해줘", orchHarness: { packageId: "p", bindingSetId: "b" } },
  { userRequest: "HTML을 저장해줘", intent: "review", orchPipelineId: "p" },
  { userRequest: "검색하지 말고 파일을 생성해줘", orchMode: "single_worker" },
]) {
  test(`conflicting route is rejected before task creation: ${JSON.stringify(input)}`, async () => {
    let created = 0;
    const service = new ConversationStartService({
      createTask: async () => { created++; return { taskRun: { id: "task" } }; },
      hold: () => () => {}, changed: () => {}, getTaskRun: async () => ({ status: "drafting", ...input,
        contract: buildTaskContract(input) }), markPlanningReady: async () => {},
      fail: async () => {}, onError: () => {},
    });
    await assert.rejects(service.start(input), /선택.*(?:읽기 전용|검색 금지)/);
    assert.equal(created, 0, "No abandoned task or silent general-chat fallback");
  });
}

test("clipboard cannot report copied after a silent native write failure", () => {
  const result = copyAnswerText({ text: "answer" }, () => {}, () => "");
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "APP_CLIPBOARD_WRITE_FAILED");
});
