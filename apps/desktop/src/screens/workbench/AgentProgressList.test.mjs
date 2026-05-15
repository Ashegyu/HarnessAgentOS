import assert from "node:assert/strict";
import test from "node:test";

import { deriveAgentProgressHeader } from "./AgentProgressList.tsx";

const progress = (stage, message) => ({
  stage,
  message,
  at: "2026-05-15T00:00:00.000Z",
});

test("terminal succeeded progress header does not expose stale parse as current work", () => {
  assert.deepEqual(
    deriveAgentProgressHeader({
      latest: progress("parse", "Worker 응답 정리 중"),
      latestTool: null,
      terminal: true,
      terminalStatus: "succeeded",
    }),
    { title: "실행 완료", stage: "Done" },
  );
});

test("terminal progress header keeps explicit complete progress message", () => {
  assert.deepEqual(
    deriveAgentProgressHeader({
      latest: progress("complete", "Worker 응답 처리 완료"),
      latestTool: null,
      terminal: true,
      terminalStatus: "succeeded",
    }),
    { title: "Worker 응답 처리 완료", stage: "Done" },
  );
});

test("running progress header still shows latest active progress", () => {
  assert.deepEqual(
    deriveAgentProgressHeader({
      latest: progress("parse", "Worker 응답 정리 중"),
      latestTool: null,
      terminal: false,
    }),
    { title: "Worker 응답 정리 중", stage: "Parse" },
  );
});
