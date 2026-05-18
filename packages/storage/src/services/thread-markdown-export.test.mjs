import { test } from "node:test";
import assert from "node:assert/strict";
import { serializeThreadMarkdown } from "./thread-markdown-export.ts";

test("serializeThreadMarkdown includes task runs, approvals, artifacts, and checkpoints", () => {
  const markdown = serializeThreadMarkdown({
    thread: {
      id: "thr_1",
      title: "Export thread",
      targetDir: "C:\\work",
      createdAt: "2026-05-18T00:00:00.000Z",
      updatedAt: "2026-05-18T00:01:00.000Z",
    },
    taskRuns: [
      {
        taskRun: {
          id: "tsk_1",
          threadId: "thr_1",
          userRequest: "write file",
          targetDir: "C:\\work",
          status: "ready_for_review",
          createdAt: "2026-05-18T00:00:00.000Z",
          updatedAt: "2026-05-18T00:01:00.000Z",
        },
        steps: [
          {
            id: "stp_1",
            taskRunId: "tsk_1",
            index: 0,
            kind: "plan",
            title: "Plan",
            status: "succeeded",
            outputSummary: "planned",
          },
        ],
        checkpoints: [
          {
            id: "ckp_1",
            taskRunId: "tsk_1",
            stepId: "stp_1",
            reason: "before_edit",
            stateRef: "harness:checkpoint/1",
            summary: "before edit",
            createdAt: "2026-05-18T00:00:30.000Z",
          },
        ],
        approvals: [
          {
            id: "apv_1",
            taskRunId: "tsk_1",
            checkpointId: "ckp_1",
            actionType: "file_write",
            actionSummary: "write README",
            status: "executed",
            decisionMessage: "approved",
          },
        ],
        artifacts: [
          {
            id: "art_1",
            taskRunId: "tsk_1",
            stepId: "stp_1",
            kind: "diff",
            title: "README diff",
            uri: "artifact://diff/1",
            summary: "changed README",
            createdAt: "2026-05-18T00:01:00.000Z",
          },
        ],
      },
    ],
  });

  assert.match(markdown, /# Export thread/);
  assert.match(markdown, /TaskRun tsk_1/);
  assert.match(markdown, /stp_1/);
  assert.match(markdown, /ckp_1/);
  assert.match(markdown, /apv_1/);
  assert.match(markdown, /art_1/);
  assert.match(markdown, /artifact:\/\/diff\/1/);
});
