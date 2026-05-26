import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const readSource = () => readFileSync(join(__dirname, "PipelinesTab.tsx"), "utf8");

test("PipelinesTab edits backflow as an agent-owned connection", () => {
  const source = readSource();

  assert.match(source, /Backflow 연결/);
  assert.match(source, /Visual Pipeline Builder/);
  assert.match(source, /buildPipelineVisualModel/);
  assert.match(source, /connectPipelineDependency/);
  assert.match(source, /connectPipelineBackflow/);
  assert.match(source, /suggestBackflowRulesForDraft/);
  assert.match(source, /visualConnection/);
  assert.match(source, /handleVisualNodeClick/);
  assert.match(source, /연결 모드/);
  assert.match(source, /의존 연결/);
  assert.match(source, /실패 backflow/);
  assert.match(source, /품질 backflow/);
  assert.match(source, /연결 삭제/);
  assert.match(source, /pipeline-visual__node-control/);
  assert.match(source, /pipeline-visual__workbench/);
  assert.match(source, /pipeline-visual__graph/);
  assert.match(source, /pipeline-visual__edges/);
  assert.match(source, /pipeline-visual__graph-node/);
  assert.match(source, /pipeline-visual__inspector/);
  assert.match(source, /graphEditorOpen/);
  assert.match(source, /pipeline-visual-builder--window/);
  assert.match(source, /handleVisualNodeDragStart/);
  assert.match(source, /handleVisualPortPointerDown/);
  assert.match(source, /handleVisualPortPointerUp/);
  assert.match(source, /onPointerMove/);
  assert.match(source, /pipeline-visual__edge--preview/);
  assert.match(source, /pipeline-visual__graph-node-header/);
  assert.match(source, /normalizeGraphNodePosition/);
  assert.match(source, /graphNodePortPoint/);
  assert.match(source, /graphEdgePath/);
  assert.match(source, /preserveAspectRatio="xMinYMin meet"/);
  assert.match(source, /pipeline-visual__graph-node--role-/);
  assert.doesNotMatch(source, /graphNodeAnchorPoint/);
  assert.doesNotMatch(source, /const sx = from\.x \+ GRAPH_NODE_WIDTH;/);
  assert.match(source, /markerEnd/);
  assert.match(source, /Backflow 자동 추가/);
  assert.match(source, /handleAddBackflowRuleForStep/);
  assert.match(source, /retryStepId:\s*retry\.id/);
  assert.match(source, /retryStepId:\s*step\.id/);
  assert.match(source, /backflowTargetCandidates/);
  assert.doesNotMatch(source, /const earlierSteps = draft\.steps\.slice\(0, i\)/);
  assert.doesNotMatch(source, /<legend>Backflow Rules<\/legend>/);
});
