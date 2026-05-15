import type {
  A2ARemoteTaskRef,
  AgentInvocation,
  Approval,
  Step,
  TaskRun,
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
}

export const buildAgentTopology = ({
  taskRun,
  steps,
  invocations,
  approvals,
  remoteTaskRefs,
}: BuildAgentTopologyInput): AgentTopology => {
  const nodes: AgentTopologyNode[] = [
    {
      id: `request:${taskRun.id}`,
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

  const orderedInvocations = orderedAgentInvocationsForDisplay(invocations);
  orderedInvocations.forEach((invocation, index) => {
    const display = describeAgentInvocationForDisplay(invocation, steps);
    const node: AgentTopologyNode = {
      id: agentNodeId(invocation.id),
      kind: "agent",
      label: display.agentName,
      displayLabel: display.agentName,
      sublabel: display.detail,
      status: invocationStatusToTopologyStatus(invocation.status),
      x: flowX(index),
      y: flowY(index, orderedInvocations.length),
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

  const chain = [`request:${taskRun.id}`, ...flowNodeIds];
  for (let i = 0; i < chain.length - 1; i += 1) {
    const source = chain[i]!;
    const target = chain[i + 1]!;
    const targetNode = nodes.find((node) => node.id === target);
    const kind: AgentTopologyEdgeKind = i === 0 ? "starts" : "handoff";
    const status = targetNode?.status ?? "idle";
    edges.push({
      id: `${kind}:${source}->${target}`,
      source,
      target,
      kind,
      label: kind === "starts" ? "starts" : "handoff",
      status,
      animated: isAnimatedStatus(status),
    });
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
    const source = flowNodeIds[flowNodeIds.length - 1] ?? `request:${taskRun.id}`;
    edges.push({
      id: `approval:${source}->${approvalNode.id}`,
      source,
      target: approvalNode.id,
      kind: "approval",
      label: "approval",
      status,
      animated: isAnimatedStatus(status),
    });
  });

  return {
    nodes,
    edges,
    summary: summarize(nodes),
  };
};

const agentNodeId = (id: string): string => `agent:${id}`;
const stepNodeId = (id: string): string => `step:${id}`;
const remoteNodeId = (invocationId: string): string => `remote:${invocationId}`;
const approvalNodeId = (id: string): string => `approval:${id}`;

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
