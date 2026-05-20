import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

globalThis.React = React;
const { QualityPanel } = await import("./QualityPanel.tsx");

const now = "2026-05-20T00:00:00.000Z";

test("QualityPanel renders targeted A2A refinement proposals", () => {
  const html = renderToStaticMarkup(
    React.createElement(QualityPanel, {
      taskRun: {
        id: "tsk_1",
        threadId: "thr_1",
        userRequest: "ship feature",
        targetDir: process.cwd(),
        status: "quality_failed",
        createdAt: now,
        updatedAt: now,
      },
      artifacts: [],
      approvals: [],
      qualityGates: [],
      repairAttempts: [],
      refinementProposals: [
        {
          id: "a2arprop_1",
          sourceKind: "quality_gate",
          taskRunId: "tsk_1",
          targetInvocationId: "ainv_1",
          endpointId: "a2a_1",
          feedbackSourceKind: "quality_gate",
          feedbackArtifactId: "art_1",
          qualityGateId: "qg_1",
          instruction: "Fix the failed test evidence.",
          referencedArtifactIds: ["art_1"],
          sourceLabel: "Quality gate failed",
          targetLabel: "Remote Coder -> ainv_1",
          reason: "Failed quality gate evidence maps to a remote A2A invocation.",
        },
      ],
      onTaskRunChanged: async () => {},
    }),
  );

  assert.match(html, /Targeted A2A refinements/);
  assert.match(html, /Remote Coder/);
  assert.match(html, /Request refinement/);
});
