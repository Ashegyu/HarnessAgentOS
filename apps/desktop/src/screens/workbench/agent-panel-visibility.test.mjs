import { test } from "node:test";
import assert from "node:assert/strict";
import {
  shouldRenderAgentPanel,
  taskRunIdToRefreshForAgentEvent,
} from "./agent-panel-visibility.ts";

test("shouldRenderAgentPanel keeps internal handoff UI visible without invocation rows", () => {
  assert.equal(
    shouldRenderAgentPanel({
      taskRunStatus: "ready_for_review",
      invocationCount: 0,
      handoffCount: 1,
      orchestrationDriven: true,
    }),
    true,
  );
});

test("shouldRenderAgentPanel still hides empty orchestration runs before any worker signal", () => {
  assert.equal(
    shouldRenderAgentPanel({
      taskRunStatus: "drafting",
      invocationCount: 0,
      handoffCount: 0,
      orchestrationDriven: true,
    }),
    false,
  );
});

test("taskRunIdToRefreshForAgentEvent refreshes selected detail when a stream starts before progress", () => {
  assert.equal(
    taskRunIdToRefreshForAgentEvent({
      eventType: "started",
      selectedTaskRunId: "tr_1",
      eventTaskRunId: undefined,
    }),
    "tr_1",
  );
});

test("taskRunIdToRefreshForAgentEvent prefers explicit progress taskRunId", () => {
  assert.equal(
    taskRunIdToRefreshForAgentEvent({
      eventType: "progress",
      selectedTaskRunId: "selected_tr",
      eventTaskRunId: "event_tr",
    }),
    "event_tr",
  );
});
