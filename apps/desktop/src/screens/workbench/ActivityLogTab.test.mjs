import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

globalThis.React = React;
const { A2ARefinementEventsTable } = await import("./ActivityLogTab.tsx");

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
