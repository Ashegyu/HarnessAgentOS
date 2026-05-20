import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

globalThis.React = React;
const { A2ARefinementEventsTable, PipelineBackflowEventsTable } = await import("./ActivityLogTab.tsx");

test("A2ARefinementEventsTable renders dedicated refinement lifecycle rows", () => {
  const html = renderToStaticMarkup(
    React.createElement(A2ARefinementEventsTable, {
      page: {
        total: 1,
        limit: 25,
        offset: 0,
        hasNext: false,
        items: [
          {
            id: "a2are_1",
            taskRunId: "tsk_1",
            threadId: "thr_1",
            threadTitle: "Thread",
            taskRunUserRequest: "ship feature",
            taskRunStatus: "running",
            attemptId: "a2ar_1",
            targetInvocationId: "ainv_1",
            endpointId: "a2a_1",
            feedbackSourceKind: "quality_gate",
            attemptIndex: 1,
            eventType: "started",
            status: "running",
            summary: "A2A refinement started",
            parentRemoteTaskId: "remote-task-1",
            parentRemoteContextId: "remote-context-1",
            referenceArtifactIds: ["art_1"],
            createdAt: "2026-05-20T00:00:00.000Z",
          },
        ],
      },
    }),
  );

  assert.match(html, /A2A Refinement Events/);
  assert.match(html, /started/);
  assert.match(html, /a2a_1/);
  assert.match(html, /remote-context-1/);
  assert.match(html, /attempt 2/);
});

test("PipelineBackflowEventsTable renders dedicated backflow lifecycle rows", () => {
  const html = renderToStaticMarkup(
    React.createElement(PipelineBackflowEventsTable, {
      page: {
        total: 1,
        limit: 25,
        offset: 0,
        hasNext: false,
        items: [
          {
            id: "pbfe_1",
            taskRunId: "tsk_1",
            threadId: "thr_1",
            threadTitle: "Thread",
            taskRunUserRequest: "ship feature",
            taskRunStatus: "running",
            attemptId: "pbf_1",
            ruleId: "bf_code",
            trigger: "step_failed",
            targetStepId: "worker_plan",
            retryStepId: "worker_code",
            attemptIndex: 0,
            eventType: "retry_succeeded",
            status: "succeeded",
            summary: "Retry succeeded",
            payload: { artifactId: "art_1" },
            createdAt: "2026-05-20T00:00:00.000Z",
          },
        ],
      },
    }),
  );

  assert.match(html, /Pipeline Backflow Events/);
  assert.match(html, /retry_succeeded/);
  assert.match(html, /bf_code/);
  assert.match(html, /worker_plan/);
  assert.match(html, /worker_code/);
});
