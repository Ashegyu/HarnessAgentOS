import type {
  A2ARemoteTaskRef,
  AgentInvocation,
  Approval,
  Artifact,
  Step,
  TaskRun,
  WorkerStep,
} from "@harness/core";
import {
  describeAgentInvocationForDisplay,
  orderedAgentInvocationsForDisplay,
} from "./agent-invocation-display";

export type AgentTopologyNodeKind =
  | "request"
  | "step"
  | "agent"
  | "approval"
  | "remote";

export type AgentTopologyStatus =
  | "idle"
  | "queued"
  | "running"
  | "waiting"
  | "succeeded"
  | "failed"
  | "cancelled";

export type AgentTopologyEdgeKind =
  | "starts"
  | "runs"
  | "handoff"
  | "remote"
  | "approval";

export interface AgentTopologyNode {
  id: string;
  kind: AgentTopologyNodeKind;
  label: string;
  displayLabel: string;
  sublabel: string;
  status: AgentTopologyStatus;
  x: number;
  y: number;
  title: string;
}

export interface AgentTopologyEdge {
  id: string;
  source: string;
  target: string;
  kind: AgentTopologyEdgeKind;
  label: string;
  status: AgentTopologyStatus;
  animated: boolean;
}

export interface AgentTopologySummary {
  active: number;
  waiting: number;
  failed: number;
  remote: number;
  completed: number;
}

export interface AgentTopology {
  nodes: AgentTopologyNode[];
  edges: AgentTopologyEdge[];
  summary: AgentTopologySummary;
}

export interface BuildAgentTopologyInput {
  taskRun: TaskRun;
  steps: readonly Step[];
  invocations: readonly AgentInvocation[];
  approvals: readonly Approval[];
  remoteTaskRefs: readonly A2ARemoteTaskRef[];
  artifacts?: readonly Artifact[];
  workerSteps?: readonly WorkerStep[];
}

export const buildAgentTopology = ({
  taskRun,
  steps,
  invocations,
  approvals,
  remoteTaskRefs,
  artifacts = [],
  workerSteps,
}: BuildAgentTopologyInput): AgentTopology => {
  const requestNodeId = `request:${taskRun.id}`;
  const nodes: AgentTopologyNode[] = [
    {
      id: requestNodeId,
      kind: "request",
      label: "User Request",
      displayLabel: "User Request",
      sublabel: taskRun.userRequest,
      status: taskRunStatusToTopologyStatus(taskRun.status),
      x: 50,
      y: 10,
      title: taskRun.userRequest,
    },
  ];
  const edges: AgentTopologyEdge[] = [];
  const flowNodeIds: string[] = [];
  let approvalSourceNodeIds: string[] = [];

  const orderedInvocations = orderedAgentInvocationsForDisplay(invocations);
  const planContext = buildPlanContext({
    artifacts,
    steps,
    workerSteps: workerSteps ?? null,
  });

  if (planContext.workerSteps.length > 0) {
    const planned = buildPlannedWorkflow({
      requestNodeId,
      nodes,
      edges,
      steps,
      orderedInvocations,
      workerSteps: planContext.workerSteps,
      workerStepIdByDbStepId: planContext.workerStepIdByDbStepId,
      dbStepIdsByWorkerStepId: planContext.dbStepIdsByWorkerStepId,
    });
    flowNodeIds.push(...planned.flowNodeIds);
    approvalSourceNodeIds = planned.approvalSourceNodeIds;
  } else {
    orderedInvocations.forEach((invocation, index) => {
      const display = describeAgentInvocationForDisplay(invocation, steps);
      const node: AgentTopologyNode = {
        id: agentNodeId(invocation.id),
        kind: "agent",
        label: display.agentName,
        displayLabel: display.agentName,
        sublabel: display.detail,
        status: invocationStatusToTopologyStatus(invocation.status),
        x: agentFlowX(index, orderedInvocations.length),
        y: agentFlowY(index, orderedInvocations.length),
        title: `${display.agentName} · ${display.detail} · ${display.providerLabel}`,
      };
      nodes.push(node);
      flowNodeIds.push(node.id);
    });

    if (orderedInvocations.length === 0) {
      const activeSteps = steps.filter((step) => step.status !== "skipped");
      activeSteps.forEach((step, index) => {
        const node: AgentTopologyNode = {
          id: stepNodeId(step.id),
          kind: "step",
          label: step.title,
          displayLabel: `Step: ${step.title}`,
          sublabel: step.kind,
          status: stepStatusToTopologyStatus(step.status),
          x: flowX(index),
          y: flowY(index, activeSteps.length),
          title: `${step.kind} · ${step.title}`,
        };
        nodes.push(node);
        flowNodeIds.push(node.id);
      });
    }

    if (orderedInvocations.length > 0) {
      flowNodeIds.forEach((target) => {
        addTopologyEdge({
          edges,
          nodes,
          source: requestNodeId,
          target,
          kind: "starts",
          label: flowNodeIds.length > 1 ? "parallel" : "starts",
        });
      });
    } else {
      const chain = [requestNodeId, ...flowNodeIds];
      for (let i = 0; i < chain.length - 1; i += 1) {
        const source = chain[i]!;
        const target = chain[i + 1]!;
        const kind: AgentTopologyEdgeKind = i === 0 ? "starts" : "handoff";
        addTopologyEdge({
          edges,
          nodes,
          source,
          target,
          kind,
          label: kind === "starts" ? "starts" : "handoff",
        });
      }
    }
  }

  remoteTaskRefs.forEach((ref) => {
    const source = agentNodeId(ref.invocationId);
    if (!nodes.some((node) => node.id === source)) return;
    const status = remoteTaskStatusToTopologyStatus(ref.state);
    const remoteNode: AgentTopologyNode = {
      id: remoteNodeId(ref.invocationId),
      kind: "remote",
      label: `A2A ${ref.endpointId}`,
      displayLabel: `Remote: A2A ${ref.endpointId}`,
      sublabel: ref.remoteTaskId ? `${ref.state} · ${ref.remoteTaskId}` : ref.state,
      status,
      x: 82,
      y: yNearSource(nodes, source, 8),
      title: [
        `endpoint ${ref.endpointId}`,
        ref.remoteTaskId ? `task ${ref.remoteTaskId}` : "",
        ref.remoteContextId ? `context ${ref.remoteContextId}` : "",
        ref.lastEventAt ?? "",
      ]
        .filter(Boolean)
        .join(" · "),
    };
    nodes.push(remoteNode);
    edges.push({
      id: `remote:${source}->${remoteNode.id}`,
      source,
      target: remoteNode.id,
      kind: "remote",
      label: "A2A",
      status,
      animated: isAnimatedStatus(status),
    });
  });

  approvals.forEach((approval, index) => {
    const status = approvalStatusToTopologyStatus(approval.status);
    const approvalNode: AgentTopologyNode = {
      id: approvalNodeId(approval.id),
      kind: "approval",
      label: approval.actionType,
      displayLabel: `Approval: ${approval.actionType}`,
      sublabel: approval.actionSummary,
      status,
      x: approvalX(index, approvals.length),
      y: 88,
      title: `${approval.actionType} · ${approval.actionSummary}`,
    };
    nodes.push(approvalNode);
    const sources =
      approvalSourceNodeIds.length > 0
        ? approvalSourceNodeIds
        : [flowNodeIds.length === 1 ? flowNodeIds[0]! : requestNodeId];
    sources.forEach((source) => {
      addTopologyEdge({
        edges,
        nodes,
        source,
        target: approvalNode.id,
        kind: "approval",
        label: "approval",
        status,
      });
    });
  });

  return {
    nodes,
    edges,
    summary: summarize(nodes),
  };
};

interface PlanContext {
  workerSteps: WorkerStep[];
  workerStepIdByDbStepId: Map<string, string>;
  dbStepIdsByWorkerStepId: Map<string, string[]>;
}

interface BuildPlannedWorkflowInput {
  requestNodeId: string;
  nodes: AgentTopologyNode[];
  edges: AgentTopologyEdge[];
  steps: readonly Step[];
  orderedInvocations: readonly AgentInvocation[];
  workerSteps: readonly WorkerStep[];
  workerStepIdByDbStepId: ReadonlyMap<string, string>;
  dbStepIdsByWorkerStepId: ReadonlyMap<string, readonly string[]>;
}

interface PlannedWorkflowResult {
  flowNodeIds: string[];
  approvalSourceNodeIds: string[];
}

interface WorkflowNodeRecord {
  nodeId: string;
  layer: number;
  order: number;
}

const buildPlanContext = ({
  artifacts,
  steps,
  workerSteps,
}: {
  artifacts: readonly Artifact[];
  steps: readonly Step[];
  workerSteps: readonly WorkerStep[] | null;
}): PlanContext => {
  const planWorkerSteps =
    workerSteps !== null ? [...workerSteps] : extractLatestWorkerSteps(artifacts);
  const workerStepIds = new Set(planWorkerSteps.map((step) => step.id));
  const workerStepIdByDbStepId = new Map<string, string>();
  const dbStepIdsByWorkerStepId = new Map<string, string[]>();

  for (const artifact of artifacts) {
    if (!artifact.stepId) continue;
    const workerStepId = workerStepIdFromArtifactUri(artifact.uri);
    if (workerStepId === null || !workerStepIds.has(workerStepId)) continue;
    recordDbStepWorkerMapping({
      workerStepIdByDbStepId,
      dbStepIdsByWorkerStepId,
      dbStepId: artifact.stepId,
      workerStepId,
    });
  }

  for (const step of steps) {
    if (workerStepIdByDbStepId.has(step.id)) continue;
    const inferred = inferWorkerStepIdFromDbStep(step, planWorkerSteps);
    if (inferred === null) continue;
    recordDbStepWorkerMapping({
      workerStepIdByDbStepId,
      dbStepIdsByWorkerStepId,
      dbStepId: step.id,
      workerStepId: inferred,
    });
  }

  return {
    workerSteps: planWorkerSteps,
    workerStepIdByDbStepId,
    dbStepIdsByWorkerStepId,
  };
};

const buildPlannedWorkflow = ({
  requestNodeId,
  nodes,
  edges,
  steps,
  orderedInvocations,
  workerSteps,
  workerStepIdByDbStepId,
  dbStepIdsByWorkerStepId,
}: BuildPlannedWorkflowInput): PlannedWorkflowResult => {
  const activeWorkerSteps = workerSteps.filter((step) => step.status !== "skipped");
  const workerStepIds = new Set(activeWorkerSteps.map((step) => step.id));
  const dbStepById = new Map(steps.map((step) => [step.id, step] as const));
  const invocationsByWorkerStepId = new Map<string, AgentInvocation[]>();
  const orphanInvocations: AgentInvocation[] = [];

  for (const invocation of orderedInvocations) {
    const workerStepId = invocation.stepId
      ? workerStepIdByDbStepId.get(invocation.stepId) ??
        (workerStepIds.has(invocation.stepId) ? invocation.stepId : undefined)
      : undefined;
    if (workerStepId && workerStepIds.has(workerStepId)) {
      const list = invocationsByWorkerStepId.get(workerStepId) ?? [];
      list.push(invocation);
      invocationsByWorkerStepId.set(workerStepId, list);
    } else {
      orphanInvocations.push(invocation);
    }
  }

  const depsByWorkerStepId = new Map<string, string[]>();
  const childrenByWorkerStepId = new Map<string, string[]>();
  activeWorkerSteps.forEach((step, index) => {
    const deps = effectiveWorkerDependsOn(activeWorkerSteps, index).filter((id) =>
      workerStepIds.has(id),
    );
    depsByWorkerStepId.set(step.id, deps);
    for (const depId of deps) {
      const children = childrenByWorkerStepId.get(depId) ?? [];
      children.push(step.id);
      childrenByWorkerStepId.set(depId, children);
    }
  });

  const layerByWorkerStepId = buildWorkerStepLayers(
    activeWorkerSteps,
    depsByWorkerStepId,
  );
  const nodeIdsByWorkerStepId = new Map<string, string[]>();
  const workflowRecords: WorkflowNodeRecord[] = [];
  const flowNodeIds: string[] = [];

  activeWorkerSteps.forEach((workerStep, workerIndex) => {
    const invocationNodes = invocationsByWorkerStepId.get(workerStep.id) ?? [];
    if (invocationNodes.length > 0) {
      invocationNodes.forEach((invocation, invocationIndex) => {
        const display = describeAgentInvocationForDisplay(invocation, steps);
        const node: AgentTopologyNode = {
          id: agentNodeId(invocation.id),
          kind: "agent",
          label: display.agentName,
          displayLabel: display.agentName,
          sublabel: display.detail,
          status: invocationStatusToTopologyStatus(invocation.status),
          x: 50,
          y: 40,
          title: `${display.agentName} · ${display.detail} · ${display.providerLabel}`,
        };
        nodes.push(node);
        addWorkflowNode({
          flowNodeIds,
          workflowRecords,
          nodeIdsByWorkerStepId,
          workerStepId: workerStep.id,
          nodeId: node.id,
          layer: layerByWorkerStepId.get(workerStep.id) ?? 0,
          order: workerIndex * 100 + invocationIndex,
        });
      });
      return;
    }

    const dbStepIds = dbStepIdsByWorkerStepId.get(workerStep.id) ?? [];
    const dbSteps = dbStepIds
      .map((id) => dbStepById.get(id))
      .filter((step): step is Step => step !== undefined && step.status !== "skipped");

    if (dbSteps.length > 0) {
      dbSteps.forEach((step, dbStepIndex) => {
        const node: AgentTopologyNode = {
          id: stepNodeId(step.id),
          kind: "step",
          label: step.title,
          displayLabel: `Step: ${step.title}`,
          sublabel: step.kind,
          status: stepStatusToTopologyStatus(step.status),
          x: 50,
          y: 40,
          title: `${step.kind} · ${step.title}`,
        };
        nodes.push(node);
        addWorkflowNode({
          flowNodeIds,
          workflowRecords,
          nodeIdsByWorkerStepId,
          workerStepId: workerStep.id,
          nodeId: node.id,
          layer: layerByWorkerStepId.get(workerStep.id) ?? 0,
          order: workerIndex * 100 + dbStepIndex,
        });
      });
      return;
    }

    const node: AgentTopologyNode = {
      id: plannedStepNodeId(workerStep.id),
      kind: "step",
      label: workerStep.title,
      displayLabel: `Step: ${workerStep.title}`,
      sublabel: workerStep.role ?? "worker",
      status: workerStepStatusToTopologyStatus(workerStep.status),
      x: 50,
      y: 40,
      title: `${workerStep.role ?? "worker"} · ${workerStep.title}`,
    };
    nodes.push(node);
    addWorkflowNode({
      flowNodeIds,
      workflowRecords,
      nodeIdsByWorkerStepId,
      workerStepId: workerStep.id,
      nodeId: node.id,
      layer: layerByWorkerStepId.get(workerStep.id) ?? 0,
      order: workerIndex * 100,
    });
  });

  const maxLayer =
    workflowRecords.length === 0
      ? 0
      : Math.max(...workflowRecords.map((record) => record.layer));
  orphanInvocations.forEach((invocation, index) => {
    const display = describeAgentInvocationForDisplay(invocation, steps);
    const node: AgentTopologyNode = {
      id: agentNodeId(invocation.id),
      kind: "agent",
      label: display.agentName,
      displayLabel: display.agentName,
      sublabel: display.detail,
      status: invocationStatusToTopologyStatus(invocation.status),
      x: 50,
      y: 40,
      title: `${display.agentName} · ${display.detail} · ${display.providerLabel}`,
    };
    nodes.push(node);
    flowNodeIds.push(node.id);
    workflowRecords.push({
      nodeId: node.id,
      layer: maxLayer + 1,
      order: activeWorkerSteps.length * 100 + index,
    });
    addTopologyEdge({
      edges,
      nodes,
      source: requestNodeId,
      target: node.id,
      kind: "starts",
      label: "starts",
    });
  });

  applyWorkflowLayout(nodes, workflowRecords);

  activeWorkerSteps.forEach((workerStep) => {
    const targets = nodeIdsByWorkerStepId.get(workerStep.id) ?? [];
    const deps = depsByWorkerStepId.get(workerStep.id) ?? [];
    const sourceIds =
      deps.length === 0
        ? [requestNodeId]
        : deps.flatMap((depId) => nodeIdsByWorkerStepId.get(depId) ?? []);
    const sources = sourceIds.length > 0 ? sourceIds : [requestNodeId];
    sources.forEach((source) => {
      targets.forEach((target) => {
        const kind: AgentTopologyEdgeKind =
          source === requestNodeId ? "starts" : "handoff";
        const sourceWorkerStepId = workerStepIdForNode(
          source,
          nodeIdsByWorkerStepId,
        );
        const siblingCount =
          sourceWorkerStepId === null
            ? targets.length
            : childrenByWorkerStepId.get(sourceWorkerStepId)?.length ?? 1;
        addTopologyEdge({
          edges,
          nodes,
          source,
          target,
          kind,
          label:
            kind === "starts"
              ? siblingCount > 1
                ? "parallel"
                : "starts"
              : siblingCount > 1
                ? "parallel"
                : "handoff",
        });
      });
    });
  });

  const leafNodeIds = activeWorkerSteps
    .filter((step) => (childrenByWorkerStepId.get(step.id) ?? []).length === 0)
    .flatMap((step) => nodeIdsByWorkerStepId.get(step.id) ?? []);

  return {
    flowNodeIds,
    approvalSourceNodeIds: leafNodeIds.length > 0 ? leafNodeIds : flowNodeIds,
  };
};

const addWorkflowNode = ({
  flowNodeIds,
  workflowRecords,
  nodeIdsByWorkerStepId,
  workerStepId,
  nodeId,
  layer,
  order,
}: {
  flowNodeIds: string[];
  workflowRecords: WorkflowNodeRecord[];
  nodeIdsByWorkerStepId: Map<string, string[]>;
  workerStepId: string;
  nodeId: string;
  layer: number;
  order: number;
}): void => {
  flowNodeIds.push(nodeId);
  workflowRecords.push({ nodeId, layer, order });
  const nodeIds = nodeIdsByWorkerStepId.get(workerStepId) ?? [];
  nodeIds.push(nodeId);
  nodeIdsByWorkerStepId.set(workerStepId, nodeIds);
};

const addTopologyEdge = ({
  edges,
  nodes,
  source,
  target,
  kind,
  label,
  status,
}: {
  edges: AgentTopologyEdge[];
  nodes: readonly AgentTopologyNode[];
  source: string;
  target: string;
  kind: AgentTopologyEdgeKind;
  label: string;
  status?: AgentTopologyStatus;
}): void => {
  const targetNode = nodes.find((node) => node.id === target);
  const resolvedStatus = status ?? targetNode?.status ?? "idle";
  edges.push({
    id: `${kind}:${source}->${target}`,
    source,
    target,
    kind,
    label,
    status: resolvedStatus,
    animated: isAnimatedStatus(resolvedStatus),
  });
};

const applyWorkflowLayout = (
  nodes: AgentTopologyNode[],
  records: readonly WorkflowNodeRecord[],
): void => {
  const nodeById = new Map(nodes.map((node) => [node.id, node] as const));
  const layers = new Map<number, WorkflowNodeRecord[]>();
  for (const record of records) {
    const list = layers.get(record.layer) ?? [];
    list.push(record);
    layers.set(record.layer, list);
  }
  const orderedLayers = [...layers.keys()].sort((a, b) => a - b);
  const totalLayers = orderedLayers.length;
  orderedLayers.forEach((layer, layerIndex) => {
    const layerRecords = [...(layers.get(layer) ?? [])].sort(
      (a, b) => a.order - b.order || a.nodeId.localeCompare(b.nodeId),
    );
    layerRecords.forEach((record, index) => {
      const node = nodeById.get(record.nodeId);
      if (!node) return;
      node.x = workflowLayerX(index, layerRecords.length);
      node.y = workflowLayerY(layerIndex, totalLayers);
    });
  });
};

const buildWorkerStepLayers = (
  workerSteps: readonly WorkerStep[],
  depsByWorkerStepId: ReadonlyMap<string, readonly string[]>,
): Map<string, number> => {
  const layers = new Map<string, number>();
  const visiting = new Set<string>();
  const workerStepIds = new Set(workerSteps.map((step) => step.id));

  const visit = (stepId: string): number => {
    const existing = layers.get(stepId);
    if (existing !== undefined) return existing;
    if (visiting.has(stepId)) return 0;
    visiting.add(stepId);
    const deps = (depsByWorkerStepId.get(stepId) ?? []).filter((depId) =>
      workerStepIds.has(depId),
    );
    const layer =
      deps.length === 0 ? 0 : Math.max(...deps.map((depId) => visit(depId))) + 1;
    visiting.delete(stepId);
    layers.set(stepId, layer);
    return layer;
  };

  workerSteps.forEach((step) => visit(step.id));
  return layers;
};

const recordDbStepWorkerMapping = ({
  workerStepIdByDbStepId,
  dbStepIdsByWorkerStepId,
  dbStepId,
  workerStepId,
}: {
  workerStepIdByDbStepId: Map<string, string>;
  dbStepIdsByWorkerStepId: Map<string, string[]>;
  dbStepId: string;
  workerStepId: string;
}): void => {
  workerStepIdByDbStepId.set(dbStepId, workerStepId);
  const dbStepIds = dbStepIdsByWorkerStepId.get(workerStepId) ?? [];
  if (!dbStepIds.includes(dbStepId)) dbStepIds.push(dbStepId);
  dbStepIdsByWorkerStepId.set(workerStepId, dbStepIds);
};

const extractLatestWorkerSteps = (
  artifacts: readonly Artifact[],
): WorkerStep[] => {
  const planArtifacts = artifacts
    .map((artifact, index) => ({ artifact, index }))
    .filter(({ artifact }) => artifact.kind === "orchestration_plan")
    .sort((a, b) => {
      const byTime =
        artifactTime(a.artifact.createdAt) - artifactTime(b.artifact.createdAt);
      if (byTime !== 0) return byTime;
      return a.index - b.index;
    });

  for (const { artifact } of planArtifacts.reverse()) {
    const workerSteps = parseWorkerStepsFromPlanSummary(artifact.summary ?? "");
    if (workerSteps.length > 0) return workerSteps;
  }
  return [];
};

const artifactTime = (value: string): number => {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
};

const planJsonRe = /```json\s*([\s\S]+?)\s*```/;

const parseWorkerStepsFromPlanSummary = (summary: string): WorkerStep[] => {
  const match = planJsonRe.exec(summary);
  if (!match) return [];
  try {
    const parsed = JSON.parse(match[1] ?? "") as { workerSteps?: unknown };
    if (!Array.isArray(parsed.workerSteps)) return [];
    return parsed.workerSteps as WorkerStep[];
  } catch {
    return [];
  }
};

const workerStepUriRe = /^harness:orchestration\/[^/]+\/([^/]+)$/;

const workerStepIdFromArtifactUri = (uri: string): string | null => {
  const match = workerStepUriRe.exec(uri);
  return match?.[1] && match[1] !== "plan" ? match[1] : null;
};

const inferWorkerStepIdFromDbStep = (
  step: Step,
  workerSteps: readonly WorkerStep[],
): string | null => {
  const matches = workerSteps.filter(
    (workerStep) =>
      step.title === workerStep.title ||
      step.title.endsWith(`] ${workerStep.title}`) ||
      step.title.endsWith(` ${workerStep.title}`),
  );
  return matches.length === 1 ? matches[0]!.id : null;
};

const effectiveWorkerDependsOn = (
  steps: readonly WorkerStep[],
  index: number,
): string[] => {
  const step = steps[index];
  if (!step) return [];
  if (step.dependsOn !== undefined) return [...step.dependsOn];
  return index > 0 ? [steps[index - 1]!.id] : [];
};

const workerStepIdForNode = (
  nodeId: string,
  nodeIdsByWorkerStepId: ReadonlyMap<string, readonly string[]>,
): string | null => {
  for (const [workerStepId, nodeIds] of nodeIdsByWorkerStepId.entries()) {
    if (nodeIds.includes(nodeId)) return workerStepId;
  }
  return null;
};

const agentNodeId = (id: string): string => `agent:${id}`;
const stepNodeId = (id: string): string => `step:${id}`;
const plannedStepNodeId = (id: string): string => `planned-step:${id}`;
const remoteNodeId = (invocationId: string): string => `remote:${invocationId}`;
const approvalNodeId = (id: string): string => `approval:${id}`;

const agentFlowX = (index: number, total: number): number => {
  if (total <= 1) return 50;
  return index % 2 === 0 ? 32 : 68;
};

const agentFlowY = (index: number, total: number): number => {
  if (total <= 1) return 40;
  const row = Math.floor(index / 2);
  const rows = Math.ceil(total / 2);
  if (rows <= 1) return 42;
  const start = 34;
  const end = Math.min(74, start + (rows - 1) * 18);
  return start + ((end - start) * row) / Math.max(rows - 1, 1);
};

const workflowLayerX = (index: number, total: number): number => {
  if (total <= 1) return 50;
  const start = 28;
  const end = 72;
  return start + ((end - start) * index) / Math.max(total - 1, 1);
};

const workflowLayerY = (layerIndex: number, totalLayers: number): number => {
  if (totalLayers <= 1) return 40;
  const start = 30;
  const end = 74;
  return start + ((end - start) * layerIndex) / Math.max(totalLayers - 1, 1);
};

const flowX = (index: number): number => (index % 2 === 0 ? 36 : 64);

const flowY = (index: number, total: number): number => {
  if (total <= 1) return 40;
  const step = Math.min(18, 54 / Math.max(total - 1, 1));
  return 30 + index * step;
};

const approvalX = (index: number, total: number): number => {
  if (total <= 1) return 50;
  const start = 28;
  const end = 72;
  return start + ((end - start) * index) / Math.max(total - 1, 1);
};

const yNearSource = (
  nodes: readonly AgentTopologyNode[],
  source: string,
  offset: number,
): number => {
  const found = nodes.find((node) => node.id === source);
  return Math.min(82, (found?.y ?? 40) + offset);
};

const isAnimatedStatus = (status: AgentTopologyStatus): boolean =>
  status === "running" || status === "waiting" || status === "queued";

const summarize = (nodes: readonly AgentTopologyNode[]): AgentTopologySummary => {
  const relevant = nodes.filter((node) => node.kind !== "request");
  return {
    active: relevant.filter((node) => node.status === "running").length,
    waiting: relevant.filter(
      (node) => node.status === "waiting" || node.status === "queued",
    ).length,
    failed: relevant.filter((node) => node.status === "failed").length,
    remote: relevant.filter((node) => node.kind === "remote").length,
    completed: relevant.filter((node) => node.status === "succeeded").length,
  };
};

const taskRunStatusToTopologyStatus = (
  status: TaskRun["status"],
): AgentTopologyStatus => {
  switch (status) {
    case "drafting":
      return "queued";
    case "running":
      return "running";
    case "waiting_for_approval":
    case "paused":
      return "waiting";
    case "blocked":
    case "quality_failed":
      return "failed";
    case "ready_for_review":
    case "done":
      return "succeeded";
    case "cancelled":
      return "cancelled";
    default:
      return "idle";
  }
};

const stepStatusToTopologyStatus = (status: Step["status"]): AgentTopologyStatus => {
  switch (status) {
    case "pending":
      return "queued";
    case "running":
      return "running";
    case "succeeded":
      return "succeeded";
    case "failed":
      return "failed";
    case "skipped":
      return "idle";
    default:
      return "idle";
  }
};

const workerStepStatusToTopologyStatus = (
  status: WorkerStep["status"],
): AgentTopologyStatus => {
  switch (status) {
    case "pending":
      return "queued";
    case "running":
      return "running";
    case "succeeded":
      return "succeeded";
    case "failed":
      return "failed";
    case "skipped":
      return "idle";
    default:
      return "idle";
  }
};

const invocationStatusToTopologyStatus = (
  status: AgentInvocation["status"],
): AgentTopologyStatus => {
  switch (status) {
    case "queued":
      return "queued";
    case "running":
      return "running";
    case "succeeded":
      return "succeeded";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    default:
      return "idle";
  }
};

const approvalStatusToTopologyStatus = (
  status: Approval["status"],
): AgentTopologyStatus => {
  switch (status) {
    case "pending":
      return "waiting";
    case "rejected":
      return "failed";
    case "approved":
    case "always_approved_for_run":
    case "executed":
      return "succeeded";
    default:
      return "idle";
  }
};

const remoteTaskStatusToTopologyStatus = (
  status: A2ARemoteTaskRef["state"],
): AgentTopologyStatus => {
  switch (status) {
    case "submitted":
    case "working":
      return "running";
    case "input-required":
    case "auth-required":
      return "waiting";
    case "completed":
      return "succeeded";
    case "failed":
    case "rejected":
      return "failed";
    case "canceled":
      return "cancelled";
    case "unknown":
    default:
      return "idle";
  }
};
