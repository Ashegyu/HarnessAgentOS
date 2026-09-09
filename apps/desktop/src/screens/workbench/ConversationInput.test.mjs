import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ConversationInput } from "./ConversationInput.tsx";
import { I18nProvider } from "../../app/i18n.tsx";

globalThis.React = React;

test("missing CLI offers connection recovery instead of promising a template task", () => {
  const html = renderToStaticMarkup(React.createElement(I18nProvider, null,
    React.createElement(ConversationInput, { threadId: "thr_test", threadTargetDir: "C:\\project", agentAvailable: false, onSubmit: async () => {} })));
  assert.match(html, /CLI 다시 확인/);
  assert.match(html, /CLI 연결을 확인/);
  assert.doesNotMatch(html, /기본 plan \/ checkpoint \/ approval/);
});

const __dirname = dirname(fileURLToPath(import.meta.url));

const readSource = (file) => readFileSync(join(__dirname, file), "utf8");

test("ConversationInput exposes task intent and omits unsafe routes for read-only requests", () => {
  const source = readSource("ConversationInput.tsx");
  assert.match(source, /aria-label="작업 목적"/);
  assert.match(source, /payload\.intent = intent/);
  assert.match(source, /!readOnly && orchEnabled && orchPipelineId/);
  assert.match(source, /!readOnly && orchEnabled && orchHarnessKey/);
  const workbench = readSource("WorkbenchShell.tsx");
  assert.match(workbench, /window\.harness\.conversation\.startTask/);
  assert.match(workbench, /contract\?\.authorization\.mode !== "read_only"/);
  assert.doesNotMatch(workbench, /advisoryResumeInFlightRef|harness\.pipelineAutoTaskRunIds/);
});

test("ConversationInput keeps orchestration selectors visible with disabled empty states", () => {
  const source = readSource("ConversationInput.tsx");

  assert.doesNotMatch(source, /\{orchEnabled && pipelines\.length > 0 &&/);
  assert.doesNotMatch(source, /\{orchEnabled && harnessRouteOptions\.length > 0 &&/);
  assert.match(source, /저장된 Pipeline 없음/);
  assert.match(source, /저장된 Binding Set 없음/);
  assert.match(source, /disabled=\{submitting \|\| readOnly \|\| noSearch \|\| !orchEnabled \|\| pipelines\.length === 0\}/);
  assert.match(
    source,
    /disabled=\{\s*submitting \|\| readOnly \|\| noSearch \|\| !orchEnabled \|\| harnessRouteOptions\.length === 0\s*\}/,
  );
});
