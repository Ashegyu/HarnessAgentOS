import { useMemo, type ReactNode } from "react";
import type {
  A2ARemoteTaskRef,
  AgentInvocation,
  Approval,
  Step,
  TaskRun,
} from "@harness/core";
import {
  buildAgentTopology,
  type AgentTopologyEdge,
  type AgentTopologyNode,
} from "./agent-topology-model";

interface AgentTopologyPanelProps {
  taskRun: TaskRun;
  steps: Step[];
  invocations: AgentInvocation[];
  approvals: Approval[];
  remoteTaskRefs: A2ARemoteTaskRef[];
  variant?: "panel" | "large";
  headerActions?: ReactNode;
}

const VIEWBOX_WIDTH = 1000;
const VIEWBOX_HEIGHT = 620;

export const AgentTopologyPanel = ({
  taskRun,
  steps,
  invocations,
  approvals,
  remoteTaskRefs,
  variant = "panel",
  headerActions,
}: AgentTopologyPanelProps): JSX.Element => {
  const topology = useMemo(
    () =>
      buildAgentTopology({
        taskRun,
        steps,
        invocations,
        approvals,
        remoteTaskRefs,
      }),
    [taskRun, steps, invocations, approvals, remoteTaskRefs],
  );
  const nodeById = useMemo(
    () => new Map(topology.nodes.map((node) => [node.id, node])),
    [topology.nodes],
  );

  return (
    <section
      className={`agent-topology agent-topology--${variant}`}
      aria-label="Agent connection graph"
    >
      <header className="panel-header panel-header--inset">
        <span className="agent-topology__header-title">Agent Graph</span>
        <span className="agent-topology__header-meta">
          {topology.nodes.length} nodes · {topology.edges.length} links
        </span>
        {headerActions !== undefined ? (
          <span className="agent-topology__header-actions">
            {headerActions}
          </span>
        ) : null}
      </header>

      <div className="agent-topology__summary" aria-label="Graph summary">
        <TopologyMetric label="Active" value={topology.summary.active} />
        <TopologyMetric label="Waiting" value={topology.summary.waiting} />
        <TopologyMetric label="Failed" value={topology.summary.failed} />
        <TopologyMetric label="Remote" value={topology.summary.remote} />
        <TopologyMetric label="Done" value={topology.summary.completed} />
      </div>

      <div className="agent-topology__canvas">
        <svg
          className="agent-topology__edges"
          viewBox={`0 0 ${VIEWBOX_WIDTH} ${VIEWBOX_HEIGHT}`}
          aria-hidden
        >
          {topology.edges.map((edge) => (
            <TopologyEdge
              key={edge.id}
              edge={edge}
              source={nodeById.get(edge.source)}
              target={nodeById.get(edge.target)}
            />
          ))}
        </svg>
        {topology.nodes.map((node) => (
          <TopologyNode key={node.id} node={node} />
        ))}
      </div>
    </section>
  );
};

const TopologyMetric = ({
  label,
  value,
}: {
  label: string;
  value: number;
}): JSX.Element => (
  <span className="agent-topology__metric">
    <strong>{value}</strong>
    <span>{label}</span>
  </span>
);

const TopologyEdge = ({
  edge,
  source,
  target,
}: {
  edge: AgentTopologyEdge;
  source: AgentTopologyNode | undefined;
  target: AgentTopologyNode | undefined;
}): JSX.Element | null => {
  if (!source || !target) return null;
  const x1 = toSvgX(source.x);
  const y1 = toSvgY(source.y);
  const x2 = toSvgX(target.x);
  const y2 = toSvgY(target.y);
  const curve = Math.max(42, Math.abs(x2 - x1) * 0.32);
  const d = `M ${x1} ${y1} C ${x1} ${y1 + curve}, ${x2} ${
    y2 - curve
  }, ${x2} ${y2}`;

  return (
    <g className="agent-topology__edge-group">
      <path
        className={`agent-topology__edge agent-topology__edge--${edge.status}${
          edge.animated ? " agent-topology__edge--animated" : ""
        }`}
        d={d}
      />
      <title>{edge.label}</title>
    </g>
  );
};

const TopologyNode = ({ node }: { node: AgentTopologyNode }): JSX.Element => (
  <div
    className={`agent-topology__node agent-topology__node--${node.kind} agent-topology__node--${node.status}`}
    style={{ left: `${node.x}%`, top: `${node.y}%` }}
    title={node.title}
  >
    <span className="agent-topology__node-kind">{node.kind}</span>
    <strong>{node.displayLabel}</strong>
    <span>{node.sublabel}</span>
  </div>
);

const toSvgX = (percent: number): number => (percent / 100) * VIEWBOX_WIDTH;
const toSvgY = (percent: number): number => (percent / 100) * VIEWBOX_HEIGHT;
