import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import type {
  A2ARegistryEntry,
  AgentPipeline,
  AgentProfile,
  ApprovalActionType,
  PipelineBackflowTrigger,
  TopologyRecommendation,
  WorkerOutputContract,
} from "@harness/core";
import {
  buildPipelineFanOutPreview,
  buildPipelineVisualModel,
  connectPipelineBackflow,
  connectPipelineDependency,
  disconnectPipelineBackflow,
  disconnectPipelineDependency,
  emptyPipelineDraft,
  moveStep,
  PIPELINE_INTENT_PRESETS,
  PIPELINE_OUTPUT_CONTRACT_CHOICES,
  PIPELINE_WORKER_ACTION_CHOICES,
  pipelineInputToDraft,
  pipelineToDraft,
  rankPipelinesForRequest,
  serializePipelineDraft,
  settingsWithDefaultPipeline,
  suggestBackflowRulesForDraft,
  topologyTaskRunOptionsFromThreadDetails,
  validatePipelineDraft,
  type PipelineDraft,
  type PipelineVisualConnectionReason,
  type PipelineVisualLink,
  type PipelineVisualModel,
  type PipelineStepDraft,
  type TopologyTaskRunOption,
} from "./pipeline-form";
import {
  WORKER_ROLE_METADATA,
  roleOptionLabel,
} from "./role-metadata";

type ListState =
  | { kind: "loading" }
  | {
      kind: "ready";
      pipelines: AgentPipeline[];
      profiles: AgentProfile[];
      remoteEntries: A2ARegistryEntry[];
      taskRuns: TopologyTaskRunOption[];
      defaultPipelineId: string;
    }
  | { kind: "error"; message: string };

interface PipelinesTabProps {
  initialTopologyTaskRunId?: string | null;
  onDefaultPipelineChanged?: (pipelineId: string) => void;
}

type VisualConnectionKind = "dependency" | PipelineBackflowTrigger;

interface VisualConnectionState {
  kind: VisualConnectionKind;
  fromStepId: string | null;
}

interface VisualGraphPoint {
  x: number;
  y: number;
}

type VisualGraphPositions = Record<string, VisualGraphPoint>;

interface VisualNodeDragState {
  stepId: string;
  pointerId: number;
  startClientX: number;
  startClientY: number;
  originX: number;
  originY: number;
}

interface VisualLinkDragState {
  kind: VisualConnectionKind;
  fromStepId: string;
  pointerId: number;
  x: number;
  y: number;
}

interface VisualGraphNodeLayout {
  stepId: string;
  x: number;
  y: number;
}

interface VisualGraphEdgeLayout {
  link: PipelineVisualLink;
  path: string;
  labelX: number;
  labelY: number;
}

interface VisualGraphLayout {
  width: number;
  height: number;
  nodes: VisualGraphNodeLayout[];
  edges: VisualGraphEdgeLayout[];
}

const GRAPH_NODE_WIDTH = 220;
const GRAPH_NODE_HEIGHT = 118;
const GRAPH_NODE_GAP_X = 86;
const GRAPH_PADDING_X = 36;
const GRAPH_TOP = 72;
const GRAPH_MIN_WIDTH = 720;
const GRAPH_MIN_HEIGHT = 310;
const GRAPH_NODE_PORT_SIZE = 14;
const GRAPH_NODE_PORT_EDGE_OFFSET = 8;
const GRAPH_NODE_BORDER_LEFT = 5;
const GRAPH_NODE_BORDER_RIGHT = 1;
const GRAPH_NODE_PORT_CENTER_OFFSET =
  GRAPH_NODE_PORT_SIZE / 2 - GRAPH_NODE_PORT_EDGE_OFFSET;

const graphNodePortPoint = (
  node: VisualGraphNodeLayout,
  side: "in" | "out",
): VisualGraphPoint => {
  return {
    x:
      side === "out"
        ? node.x +
          GRAPH_NODE_WIDTH -
          GRAPH_NODE_BORDER_RIGHT -
          GRAPH_NODE_PORT_CENTER_OFFSET
        : node.x + GRAPH_NODE_BORDER_LEFT + GRAPH_NODE_PORT_CENTER_OFFSET,
    y: node.y + GRAPH_NODE_HEIGHT / 2,
  };
};

const graphEdgePath = (
  from: VisualGraphNodeLayout,
  to: VisualGraphNodeLayout,
  kind: PipelineVisualLink["kind"],
): Pick<VisualGraphEdgeLayout, "path" | "labelX" | "labelY"> => {
  const source = graphNodePortPoint(from, "out");
  const target = graphNodePortPoint(to, "in");
  const dx = target.x - source.x;
  const dy = target.y - source.y;
  const curve = Math.min(
    240,
    Math.max(64, Math.hypot(dx, dy) * (kind === "dependency" ? 0.34 : 0.46)),
  );
  const labelOffset = kind === "dependency" ? -12 : -24;

  return {
    path: `M ${source.x} ${source.y} C ${source.x + curve} ${source.y}, ${target.x - curve} ${target.y}, ${target.x} ${target.y}`,
    labelX: (source.x + target.x) / 2,
    labelY: (source.y + target.y) / 2 + labelOffset,
  };
};

const buildVisualGraphLayout = (
  model: PipelineVisualModel,
  positions: VisualGraphPositions = {},
): VisualGraphLayout => {
  const nodeCount = model.nodes.length;
  const baseWidth = Math.max(
    GRAPH_MIN_WIDTH,
    GRAPH_PADDING_X * 2 +
      nodeCount * GRAPH_NODE_WIDTH +
      Math.max(0, nodeCount - 1) * GRAPH_NODE_GAP_X,
  );
  const nodes = model.nodes.map((node, index) => {
    const fallback = {
      x: GRAPH_PADDING_X + index * (GRAPH_NODE_WIDTH + GRAPH_NODE_GAP_X),
      y: GRAPH_TOP + (index % 2 === 1 ? 34 : 0),
    };
    const saved = positions[node.stepId];
    return {
      stepId: node.stepId,
      x: saved?.x ?? fallback.x,
      y: saved?.y ?? fallback.y,
    };
  });
  const width = Math.max(
    baseWidth,
    ...nodes.map((node) => node.x + GRAPH_NODE_WIDTH + GRAPH_PADDING_X),
  );
  const height = Math.max(
    GRAPH_MIN_HEIGHT,
    ...nodes.map((node) => node.y + GRAPH_NODE_HEIGHT + GRAPH_PADDING_X),
  );
  const layoutByStepId = new Map(
    nodes.map((node) => [node.stepId, node] as const),
  );
  const edges: VisualGraphEdgeLayout[] = model.links
    .map((link): VisualGraphEdgeLayout | null => {
      const from = layoutByStepId.get(link.fromStepId);
      const to = layoutByStepId.get(link.toStepId);
      if (!from || !to) return null;
      return {
        link,
        ...graphEdgePath(from, to, link.kind),
      };
    })
    .filter((edge): edge is VisualGraphEdgeLayout => edge !== null);
  return { width, height, nodes, edges };
};

const normalizeGraphNodePosition = (
  value: VisualGraphPoint,
): VisualGraphPoint => {
  return {
    x: Math.max(GRAPH_PADDING_X, value.x),
    y: Math.max(GRAPH_PADDING_X, value.y),
  };
};

const graphPointerPoint = (
  event: ReactPointerEvent<HTMLElement>,
  graph: HTMLDivElement | null,
): VisualGraphPoint => {
  if (!graph) return { x: 0, y: 0 };
  const rect = graph.getBoundingClientRect();
  return {
    x: event.clientX - rect.left,
    y: event.clientY - rect.top,
  };
};

const errorMessage = (e: unknown): string =>
  e instanceof Error ? e.message : String(e);

const roleDisplay = (role: string): string =>
  role in WORKER_ROLE_METADATA
    ? roleOptionLabel(role as AgentProfile["role"])
    : role;

const visualConnectionKindLabel = (kind: VisualConnectionKind): string => {
  switch (kind) {
    case "dependency":
      return "의존 연결";
    case "step_failed":
      return "실패 backflow";
    case "quality_failed":
      return "품질 backflow";
  }
};

const visualConnectionReasonLabel = (
  reason: PipelineVisualConnectionReason | undefined,
): string => {
  switch (reason) {
    case "missing_step":
      return "대상 node를 찾을 수 없습니다.";
    case "same_step":
      return "같은 node끼리는 연결할 수 없습니다.";
    case "duplicate":
      return "이미 같은 연결이 있습니다.";
    case "cycle":
      return "dependency cycle이 생겨 연결할 수 없습니다.";
    case "invalid_backflow_target":
      return "backflow 대상은 retry node의 upstream dependency path 안에 있어야 합니다.";
    default:
      return "연결을 만들 수 없습니다.";
  }
};

const visualRoleClass = (role: AgentProfile["role"] | undefined): string =>
  role
    ? `pipeline-visual__graph-node--role-${role.replace(/[^a-z0-9_-]/gi, "-")}`
    : "pipeline-visual__graph-node--role-unknown";

const newStepId = (): string =>
  `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;

const newStep = (
  firstProfileId: string,
  previousStepId?: string,
): PipelineStepDraft => ({
  id: newStepId(),
  agentProfileId: firstProfileId,
  remoteEndpointId: "",
  title: "",
  instruction: "",
  expectedArtifactKinds: ["log"],
  dependsOn: previousStepId ? [previousStepId] : [],
  allowedActions: null,
  outputContract: "",
});

const newBackflowRuleId = (): string =>
  `bf_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;

const stepTitle = (
  steps: readonly PipelineStepDraft[],
  stepId: string,
): string => steps.find((step) => step.id === stepId)?.title.trim() || stepId;

const effectiveStepDependsOn = (
  steps: readonly PipelineStepDraft[],
  index: number,
): string[] => {
  const step = steps[index];
  if (!step) return [];
  return step.dependsOn ?? (index > 0 ? [steps[index - 1]!.id] : []);
};

const hasStepDependencyPath = (
  steps: readonly PipelineStepDraft[],
  targetStepId: string,
  retryStepId: string,
): boolean => {
  const stepIndexById = new Map(
    steps.map((step, index) => [step.id, index] as const),
  );
  const visited = new Set<string>();
  const visit = (stepId: string): boolean => {
    if (stepId === targetStepId) return true;
    if (visited.has(stepId)) return false;
    visited.add(stepId);
    const index = stepIndexById.get(stepId);
    if (index === undefined) return false;
    return effectiveStepDependsOn(steps, index).some((depId) => visit(depId));
  };
  return visit(retryStepId);
};

const backflowTargetCandidates = (
  steps: readonly PipelineStepDraft[],
  retryStepId: string,
): PipelineStepDraft[] => {
  const retryIndex = steps.findIndex((step) => step.id === retryStepId);
  if (retryIndex <= 0) return [];
  return steps
    .slice(0, retryIndex)
    .filter((step) => hasStepDependencyPath(steps, step.id, retryStepId));
};

export const PipelinesTab = ({
  initialTopologyTaskRunId = null,
  onDefaultPipelineChanged,
}: PipelinesTabProps): JSX.Element => {
  const [list, setList] = useState<ListState>({ kind: "loading" });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<PipelineDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recommendTaskRunId, setRecommendTaskRunId] = useState("");
  const [recommendations, setRecommendations] = useState<
    TopologyRecommendation[]
  >([]);
  const [recommending, setRecommending] = useState(false);
  const [recommendationError, setRecommendationError] = useState<
    string | null
  >(null);
  const [feedbackMessage, setFeedbackMessage] = useState<string | null>(null);
  const [pipelineRequestFilter, setPipelineRequestFilter] = useState("");
  const [visualConnection, setVisualConnection] =
    useState<VisualConnectionState | null>(null);
  const [visualConnectionMessage, setVisualConnectionMessage] = useState<
    string | null
  >(null);
  const [selectedVisualStepId, setSelectedVisualStepId] = useState<
    string | null
  >(null);
  const [graphEditorOpen, setGraphEditorOpen] = useState(false);
  const [visualGraphPositions, setVisualGraphPositions] =
    useState<VisualGraphPositions>({});
  const [visualNodeDrag, setVisualNodeDrag] =
    useState<VisualNodeDragState | null>(null);
  const [visualLinkDrag, setVisualLinkDrag] =
    useState<VisualLinkDragState | null>(null);
  const visualGraphRef = useRef<HTMLDivElement | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [pipelines, profiles, remoteEntries, threads, settings] =
        await Promise.all([
          window.harness.pipeline.list(),
          window.harness.agents.list(),
          window.harness.remoteAgents.list(),
          window.harness.state.listThreads(),
          window.harness.settings.get(),
        ]);
      const details = await Promise.all(
        threads.slice(0, 25).map(async (thread) => {
          try {
            return await window.harness.state.getThread({
              threadId: thread.id,
            });
          } catch {
            return null;
          }
        }),
      );
      const taskRuns = topologyTaskRunOptionsFromThreadDetails(details);
      setList({
        kind: "ready",
        pipelines,
        profiles,
        remoteEntries,
        taskRuns,
        defaultPipelineId: settings.orchestration.defaultPipelineId,
      });
    } catch (e) {
      setList({ kind: "error", message: errorMessage(e) });
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (
      initialTopologyTaskRunId !== null &&
      initialTopologyTaskRunId.length > 0
    ) {
      setRecommendTaskRunId((current) =>
        current.length === 0 ? initialTopologyTaskRunId : current,
      );
    }
  }, [initialTopologyTaskRunId]);

  useEffect(() => {
    if (list.kind !== "ready") return;
    if (selectedId === null) {
      setDraft(null);
      return;
    }
    if (selectedId === "__new__") {
      setDraft((current) =>
        current !== null && current.id === null ? current : emptyPipelineDraft(),
      );
      return;
    }
    const found = list.pipelines.find((p) => p.id === selectedId);
    setDraft(found ? pipelineToDraft(found) : null);
  }, [selectedId, list]);

  const profiles = list.kind === "ready" ? list.profiles : [];
  const remoteEntries = list.kind === "ready" ? list.remoteEntries : [];
  const taskRunOptions = list.kind === "ready" ? list.taskRuns : [];
  const defaultPipelineId =
    list.kind === "ready" ? list.defaultPipelineId : "";
  const rankedPipelines = useMemo(
    () =>
      list.kind === "ready"
        ? rankPipelinesForRequest(
            list.pipelines,
            pipelineRequestFilter,
            profiles,
          )
        : [],
    [list, pipelineRequestFilter, profiles],
  );
  const activePipelineSuggestion =
    rankedPipelines.find((entry) => entry.recommended) ?? null;
  const selectedTaskRunOption = taskRunOptions.find(
    (option) => option.id === recommendTaskRunId.trim(),
  );
  const selectableRemoteEntries = remoteEntries.filter(
    (entry) => entry.endpoint.enabled && entry.endpoint.trusted,
  );
  const validationErrors = useMemo(
    () => (draft ? validatePipelineDraft(draft, profiles, remoteEntries) : []),
    [draft, profiles, remoteEntries],
  );
  const fanOutPreview = useMemo(
    () =>
      draft
        ? buildPipelineFanOutPreview(draft, profiles, remoteEntries)
        : null,
    [draft, profiles, remoteEntries],
  );
  const visualModel = useMemo(
    () => (draft ? buildPipelineVisualModel(draft, profiles, remoteEntries) : null),
    [draft, profiles, remoteEntries],
  );
  const visualGraphLayout = useMemo(
    () =>
      visualModel
        ? buildVisualGraphLayout(visualModel, visualGraphPositions)
        : null,
    [visualModel, visualGraphPositions],
  );
  const suggestedBackflowRules = useMemo(
    () => (draft ? suggestBackflowRulesForDraft(draft) : []),
    [draft],
  );
  const selectedVisualStepIndex =
    draft && selectedVisualStepId
      ? draft.steps.findIndex((step) => step.id === selectedVisualStepId)
      : -1;
  const selectedVisualStep =
    draft && selectedVisualStepIndex >= 0
      ? draft.steps[selectedVisualStepIndex]!
      : null;

  const updateDraft = (patch: Partial<PipelineDraft>): void => {
    setDraft((d) => (d ? { ...d, ...patch } : d));
  };

  const updateStep = (i: number, patch: Partial<PipelineStepDraft>): void => {
    setDraft((d) =>
      d
        ? {
            ...d,
            steps: d.steps.map((s, idx) => (idx === i ? { ...s, ...patch } : s)),
          }
        : d,
    );
  };

  const applyVisualConnection = (
    kind: VisualConnectionKind,
    fromStepId: string,
    toStepId: string,
  ): void => {
    if (!draft) return;
    const result =
      kind === "dependency"
        ? connectPipelineDependency(draft, fromStepId, toStepId)
        : connectPipelineBackflow(draft, fromStepId, toStepId, kind);
    setDraft(result.draft);
    setVisualConnection(null);
    setVisualLinkDrag(null);
    setVisualConnectionMessage(
      result.changed
        ? `${visualConnectionKindLabel(kind)}을 추가했습니다.`
        : visualConnectionReasonLabel(result.reason),
    );
  };

  const handleAddStep = (): void => {
    if (!draft || profiles.length === 0) return;
    const firstProfileId = profiles[0]!.id;
    const previousStepId =
      draft.steps.length > 0 ? draft.steps[draft.steps.length - 1]!.id : undefined;
    const step = newStep(firstProfileId, previousStepId);
    const nextIndex = draft.steps.length;
    setDraft({
      ...draft,
      steps: [...draft.steps, step],
    });
    setSelectedVisualStepId(step.id);
    setVisualGraphPositions((current) => ({
      ...current,
      [step.id]: {
        x: GRAPH_PADDING_X + nextIndex * (GRAPH_NODE_WIDTH + GRAPH_NODE_GAP_X),
        y: GRAPH_TOP + (nextIndex % 2 === 1 ? 34 : 0),
      },
    }));
  };

  const handleRemoveStep = (i: number): void => {
    const removedStepId = draft?.steps[i]?.id;
    setDraft((d) =>
      d ? { ...d, steps: d.steps.filter((_, idx) => idx !== i) } : d,
    );
    if (removedStepId && selectedVisualStepId === removedStepId) {
      setSelectedVisualStepId(null);
    }
    if (removedStepId) {
      setVisualGraphPositions((current) => {
        const { [removedStepId]: _removed, ...rest } = current;
        return rest;
      });
    }
  };

  const handleMoveStep = (i: number, delta: number): void => {
    setDraft((d) => (d ? { ...d, steps: moveStep(d.steps, i, delta) } : d));
  };

  const handleAddBackflowRuleForStep = (stepIndex: number): void => {
    if (!draft || stepIndex <= 0 || stepIndex >= draft.steps.length) return;
    const retry = draft.steps[stepIndex]!;
    const target = backflowTargetCandidates(draft.steps, retry.id).at(-1);
    if (!target) return;
    updateDraft({
      backflowRules: [
        ...(draft.backflowRules ?? []),
        {
          id: newBackflowRuleId(),
          trigger: "step_failed",
          targetStepId: target.id,
          retryStepId: retry.id,
          maxAttempts: 2,
        },
      ],
    });
  };

  const handleAddSuggestedBackflows = (): void => {
    setDraft((d) => {
      if (!d) return d;
      const suggested = suggestBackflowRulesForDraft(d);
      if (suggested.length === 0) return d;
      return {
        ...d,
        backflowRules: [...(d.backflowRules ?? []), ...suggested],
      };
    });
  };

  const handleVisualConnectionMode = (kind: VisualConnectionKind): void => {
    setVisualConnection({ kind, fromStepId: null });
    setVisualConnectionMessage(
      `${visualConnectionKindLabel(kind)} 모드: 출발 node를 선택하세요.`,
    );
  };

  const handleVisualNodeClick = (stepId: string): void => {
    if (!draft) return;
    if (!visualConnection) {
      setSelectedVisualStepId(stepId);
      setVisualConnectionMessage(null);
      return;
    }
    if (visualConnection.fromStepId === null) {
      setVisualConnection({ ...visualConnection, fromStepId: stepId });
      setVisualConnectionMessage(
        `${stepTitle(draft.steps, stepId)}에서 시작합니다. 연결할 대상 node를 선택하세요.`,
      );
      return;
    }

    applyVisualConnection(
      visualConnection.kind,
      visualConnection.fromStepId,
      stepId,
    );
  };

  const handleVisualLinkRemove = (link: PipelineVisualLink): void => {
    if (!draft) return;
    const result =
      link.kind === "dependency"
        ? disconnectPipelineDependency(draft, link.fromStepId, link.toStepId)
        : disconnectPipelineBackflow(draft, link.id.replace(/^backflow:/, ""));
    setDraft(result.draft);
    setVisualConnectionMessage(
      result.changed ? "연결을 삭제했습니다." : visualConnectionReasonLabel(result.reason),
    );
  };

  const handleVisualNodeDragStart = (
    event: ReactPointerEvent<HTMLElement>,
    stepId: string,
    layout: VisualGraphNodeLayout,
  ): void => {
    if (saving) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setSelectedVisualStepId(stepId);
    setVisualNodeDrag({
      stepId,
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      originX: layout.x,
      originY: layout.y,
    });
  };

  const handleVisualPortPointerDown = (
    event: ReactPointerEvent<HTMLButtonElement>,
    stepId: string,
  ): void => {
    if (saving) return;
    event.preventDefault();
    event.stopPropagation();
    const kind = visualConnection?.kind ?? "dependency";
    const point = graphPointerPoint(event, visualGraphRef.current);
    setSelectedVisualStepId(stepId);
    setVisualConnection({ kind, fromStepId: stepId });
    setVisualLinkDrag({
      kind,
      fromStepId: stepId,
      pointerId: event.pointerId,
      x: point.x,
      y: point.y,
    });
    setVisualConnectionMessage(
      `${visualConnectionKindLabel(kind)}: 대상 node의 입력 port에 놓으세요.`,
    );
  };

  const handleVisualPortPointerUp = (
    event: ReactPointerEvent<HTMLButtonElement>,
    targetStepId: string,
  ): void => {
    if (!visualLinkDrag) return;
    event.preventDefault();
    event.stopPropagation();
    applyVisualConnection(
      visualLinkDrag.kind,
      visualLinkDrag.fromStepId,
      targetStepId,
    );
  };

  const handleVisualGraphPointerMove = (
    event: ReactPointerEvent<HTMLDivElement>,
  ): void => {
    if (visualNodeDrag && event.pointerId === visualNodeDrag.pointerId) {
      const next = normalizeGraphNodePosition(
        {
          x:
            visualNodeDrag.originX +
            (event.clientX - visualNodeDrag.startClientX),
          y:
            visualNodeDrag.originY +
            (event.clientY - visualNodeDrag.startClientY),
        },
      );
      setVisualGraphPositions((current) => ({
        ...current,
        [visualNodeDrag.stepId]: next,
      }));
      return;
    }
    if (visualLinkDrag && event.pointerId === visualLinkDrag.pointerId) {
      const point = graphPointerPoint(event, visualGraphRef.current);
      setVisualLinkDrag({ ...visualLinkDrag, x: point.x, y: point.y });
    }
  };

  const handleVisualGraphPointerUp = (
    event: ReactPointerEvent<HTMLDivElement>,
  ): void => {
    if (visualNodeDrag && event.pointerId === visualNodeDrag.pointerId) {
      setVisualNodeDrag(null);
    }
    if (visualLinkDrag && event.pointerId === visualLinkDrag.pointerId) {
      setVisualLinkDrag(null);
      setVisualConnection(null);
      setVisualConnectionMessage("연결이 취소되었습니다.");
    }
  };

  const updateBackflowRule = (
    i: number,
    patch: Partial<PipelineDraft["backflowRules"][number]>,
  ): void => {
    setDraft((d) =>
      d
        ? {
            ...d,
            backflowRules: (d.backflowRules ?? []).map((rule, idx) =>
              idx === i ? { ...rule, ...patch } : rule,
            ),
          }
        : d,
    );
  };

  const handleRemoveBackflowRule = (i: number): void => {
    setDraft((d) =>
      d
        ? {
            ...d,
            backflowRules: (d.backflowRules ?? []).filter((_, idx) => idx !== i),
          }
        : d,
    );
  };

  const handleSave = async (): Promise<void> => {
    if (!draft || validationErrors.length > 0) return;
    setSaving(true);
    setError(null);
    try {
      const payload = serializePipelineDraft(draft);
      let result: AgentPipeline;
      if (draft.id === null) {
        // create
        result = await window.harness.pipeline.create({
          pipeline: payload as Parameters<
            typeof window.harness.pipeline.create
          >[0]["pipeline"],
        });
      } else {
        const full = {
          ...(payload as AgentPipeline),
          // The IPC layer ignores these on the way in; satisfy the type.
          createdAt: new Date(0).toISOString(),
          updatedAt: new Date(0).toISOString(),
        };
        result = await window.harness.pipeline.update({ pipeline: full });
      }
      await refresh();
      setSelectedId(result.id);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (): Promise<void> => {
    if (!draft || draft.id === null) return;
    if (
      !window.confirm(`"${draft.name}" 파이프라인을 삭제하시겠습니까?`)
    ) {
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await window.harness.pipeline.delete({ pipelineId: draft.id });
      await refresh();
      setSelectedId(null);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const profileName = (id: string): string =>
    profiles.find((p) => p.id === id)?.name ?? `(missing: ${id})`;
  const profileRoleDescription = (id: string): string => {
    const profile = profiles.find((p) => p.id === id);
    if (!profile) return "연결된 Agent Profile을 찾을 수 없습니다.";
    const meta = WORKER_ROLE_METADATA[profile.role];
    return `${meta.label}: ${meta.description}`;
  };
  const profileRole = (id: string): AgentProfile["role"] | undefined =>
    profiles.find((p) => p.id === id)?.role;
  const remoteName = (id: string): string =>
    remoteEntries.find((entry) => entry.endpoint.id === id)?.endpoint.name ??
    `(missing remote: ${id})`;
  const effectiveDependsOn = (
    step: PipelineStepDraft,
    index: number,
  ): string[] =>
    step.dependsOn ??
    (index > 0 && draft ? [draft.steps[index - 1]!.id] : []);
  const toggleDependency = (
    index: number,
    dependencyId: string,
    checked: boolean,
  ): void => {
    if (!draft) return;
    const step = draft.steps[index];
    if (!step) return;
    const current = new Set(effectiveDependsOn(step, index));
    if (checked) current.add(dependencyId);
    else current.delete(dependencyId);
    updateStep(index, { dependsOn: [...current] });
  };

  const handleSetDefaultPipeline = async (): Promise<void> => {
    if (!draft || draft.id === null) return;
    setSaving(true);
    setError(null);
    try {
      const settings = await window.harness.settings.get();
      await window.harness.settings.update(
        settingsWithDefaultPipeline(settings, draft.id),
      );
      onDefaultPipelineChanged?.(draft.id);
      await refresh();
      setSelectedId(draft.id);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const handleRecommend = async (): Promise<void> => {
    const taskRunId = recommendTaskRunId.trim();
    if (taskRunId.length === 0) return;
    setRecommending(true);
    setRecommendationError(null);
    setFeedbackMessage(null);
    try {
      const result = await window.harness.topology.recommend({
        taskRunId,
        maxCandidates: 3,
      });
      setRecommendations(result);
      if (result.length === 0) {
        setRecommendationError(
          "추천 후보가 없습니다. AgentProfile 구성을 먼저 확인하세요.",
        );
      }
    } catch (e) {
      setRecommendations([]);
      setRecommendationError(errorMessage(e));
    } finally {
      setRecommending(false);
    }
  };

  const applyRecommendation = (
    recommendation: TopologyRecommendation,
  ): void => {
    setSelectedId("__new__");
    setDraft(pipelineInputToDraft(recommendation.pipelineDraft));
    setError(null);
    void recordTopologyFeedback(recommendation, "applied");
  };

  const dismissRecommendation = (
    recommendation: TopologyRecommendation,
  ): void => {
    setRecommendations((current) =>
      current.filter((item) => item.id !== recommendation.id),
    );
    void recordTopologyFeedback(recommendation, "dismissed");
  };

  const recordTopologyFeedback = async (
    recommendation: TopologyRecommendation,
    decision: "applied" | "dismissed",
  ): Promise<void> => {
    try {
      await window.harness.topology.recordFeedback({
        taskRunId: recommendation.taskRunId,
        recommendationId: recommendation.id,
        decision,
      });
      setFeedbackMessage(
        decision === "applied"
          ? "추천 적용 기록을 남겼습니다."
          : "추천 무시 기록을 남겼습니다.",
      );
    } catch (e) {
      setRecommendationError(errorMessage(e));
    }
  };
  const toggleAllowedAction = (
    index: number,
    action: ApprovalActionType,
    checked: boolean,
  ): void => {
    if (!draft) return;
    const current = new Set(draft.steps[index]?.allowedActions ?? []);
    if (checked) current.add(action);
    else current.delete(action);
    updateStep(index, { allowedActions: [...current] });
  };

  return (
    <div className="pipelines-tab">
      <div className="pipelines-tab__banner" role="note">
        <strong>Agent Pipeline.</strong>{" "}
        여러 Agent Profile을 의존 관계로 묶은 재사용 가능한 실행 흐름입니다.
        각 step은 role, 프롬프트, 허용 action, 출력 계약을 따로 가질 수
        있으며 실행은 기존 승인/품질 게이트를 그대로 통과합니다.
      </div>

      <div className="pipelines-tab__split">
        <aside className="pipelines-tab__list">
          <header className="pipelines-tab__list-header">
            <span>파이프라인</span>
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => {
                setDraft(emptyPipelineDraft());
                setSelectedId("__new__");
              }}
              disabled={saving || profiles.length === 0}
              title={
                profiles.length === 0
                  ? "Agents 탭에서 먼저 프로필을 만드세요"
                  : undefined
              }
            >
              + 새 파이프라인
            </button>
          </header>
          {list.kind === "ready" && list.pipelines.length > 0 && (
            <div className="pipeline-intent-filter">
              <label className="settings-field">
                <span className="settings-field__label">
                  요청 유형 추천
                </span>
                <input
                  type="text"
                  className="settings-field__input"
                  aria-label="파이프라인 요청 유형"
                  value={pipelineRequestFilter}
                  placeholder="예: 빌드 에러, 리팩터링, 보안 리뷰"
                  onChange={(e) => setPipelineRequestFilter(e.target.value)}
                />
                <span className="settings-field__hint">
                  유형 키워드를 적으면 아래 chip 후보가 좁혀지고 pipeline 추천 점수가
                  이 키워드 기준으로 다시 계산됩니다.
                </span>
              </label>
              <div
                className="pipeline-intent-filter__chips"
                role="group"
                aria-label="요청 유형 빠른 선택"
              >
                {PIPELINE_INTENT_PRESETS.map((preset) => (
                  <button
                    key={preset.key}
                    type="button"
                    className="pipeline-intent-filter__chip"
                    onClick={() => setPipelineRequestFilter(preset.requestHint)}
                  >
                    {preset.requestHint}
                  </button>
                ))}
              </div>
              {activePipelineSuggestion !== null && (
                <p className="pipeline-intent-filter__summary">
                  추천 우선: {activePipelineSuggestion.pipeline.name} ·{" "}
                  {activePipelineSuggestion.reason}
                </p>
              )}
            </div>
          )}
          {list.kind === "loading" && (
            <div className="empty-state">불러오는 중…</div>
          )}
          {list.kind === "error" && (
            <div
              className="empty-state"
              style={{ color: "var(--status-failed)" }}
            >
              {list.message}
            </div>
          )}
          {list.kind === "ready" && list.pipelines.length === 0 && (
            <div className="empty-state">
              등록된 파이프라인이 없습니다.
            </div>
          )}
          {list.kind === "ready" && (
            <ul className="pipelines-tab__items">
              {rankedPipelines.map((entry) => (
                <li key={entry.pipeline.id}>
                  <button
                    type="button"
                    className={`pipelines-tab__item${
                      selectedId === entry.pipeline.id
                        ? " pipelines-tab__item--selected"
                        : ""
                    }`}
                    onClick={() => setSelectedId(entry.pipeline.id)}
                  >
                    <span className="pipelines-tab__item-name">
                      {entry.pipeline.name}
                    </span>
                    <span className="pipelines-tab__item-meta">
                      {entry.pipeline.steps.length} step
                      {entry.pipeline.id === defaultPipelineId
                        ? " · 기본"
                        : ""}
                    </span>
                    {entry.recommended && (
                      <span className="pipelines-tab__item-reason">
                        추천 · {entry.reason}
                      </span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </aside>

        <section className="pipelines-tab__editor">
          {draft === null ? (
            <div className="empty-state">
              파이프라인을 선택하거나 새로 만들어 편집하세요.
            </div>
          ) : (
            <div className="pipelines-tab__form">
              <h3 className="pipelines-tab__heading">
                {draft.id === null ? "새 파이프라인" : draft.name || "(이름 없음)"}
              </h3>

              <fieldset className="settings-fieldset">
                <legend>Topology 추천</legend>
                <p className="settings-field__hint">
                  최근 TaskRun의 요청, capability, instinct trace를 보고 적절한
                  role 조합과 dependency 구조를 draft로 제안합니다.
                </p>
                <div className="pipeline-recommendation__controls">
                  <label className="settings-field pipeline-recommendation__task">
                    <span className="settings-field__label">TaskRun ID</span>
                    <input
                      type="text"
                      list="topology-task-runs"
                      className="settings-field__input"
                      value={recommendTaskRunId}
                      disabled={saving || recommending}
                      placeholder={
                        taskRunOptions.length > 0
                          ? "최근 TaskRun을 선택하거나 tsk_... 입력"
                          : "tsk_..."
                      }
                      onChange={(e) => setRecommendTaskRunId(e.target.value)}
                    />
                    <datalist id="topology-task-runs">
                      {taskRunOptions.map((option) => (
                        <option key={option.id} value={option.id}>
                          {option.label}
                        </option>
                      ))}
                    </datalist>
                  </label>
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm"
                    disabled={
                      saving ||
                      recommending ||
                      recommendTaskRunId.trim().length === 0
                    }
                    onClick={() => void handleRecommend()}
                  >
                    {recommending ? "추천 중…" : "추천 불러오기"}
                  </button>
                </div>
                {selectedTaskRunOption && (
                  <div className="pipeline-recommendation__selected">
                    <span>{selectedTaskRunOption.threadTitle}</span>
                    <strong>{selectedTaskRunOption.status}</strong>
                    <p>{selectedTaskRunOption.userRequest}</p>
                  </div>
                )}
                {recommendationError && (
                  <div
                    className="pipeline-recommendation__error"
                    role="alert"
                  >
                    {recommendationError}
                  </div>
                )}
                {feedbackMessage && (
                  <div className="pipeline-recommendation__feedback">
                    {feedbackMessage}
                  </div>
                )}
                {recommendations.length > 0 && (
                  <div className="pipeline-recommendation__list">
                    {recommendations.map((recommendation) => (
                      <article
                        key={recommendation.id}
                        className="pipeline-recommendation"
                      >
                        <header className="pipeline-recommendation__header">
                          <div>
                            <h4>{recommendation.title}</h4>
                            <p>{recommendation.description}</p>
                          </div>
                          <span className="pipeline-recommendation__confidence">
                            {Math.round(recommendation.confidence * 100)}%
                          </span>
                        </header>
                        <ol className="pipeline-recommendation__steps">
                          {recommendation.steps.map((entry) => (
                            <li key={entry.step.id}>
                              <strong>{entry.step.title}</strong>
                              <span>
                                {entry.step.allowedActions?.length
                                  ? entry.step.allowedActions.join(", ")
                                  : "직접 side effect 없음"}
                              </span>
                            </li>
                          ))}
                        </ol>
                        {recommendation.warnings.length > 0 && (
                          <ul className="pipeline-recommendation__warnings">
                            {recommendation.warnings.map((warning, i) => (
                              <li key={i}>{warning}</li>
                            ))}
                          </ul>
                        )}
                        <div className="pipeline-recommendation__footer">
                          <span>
                            capability{" "}
                            {recommendation.source.capabilityIds.length} ·
                            instinct{" "}
                            {recommendation.source.instinctIds.length} · trace{" "}
                            {recommendation.source.traceIds.length}
                          </span>
                          <button
                            type="button"
                            className="btn btn--primary btn--sm"
                            disabled={saving}
                            onClick={() =>
                              applyRecommendation(recommendation)
                            }
                          >
                            draft에 적용
                          </button>
                          <button
                            type="button"
                            className="btn btn--ghost btn--sm"
                            disabled={saving}
                            onClick={() =>
                              dismissRecommendation(recommendation)
                            }
                          >
                            무시
                          </button>
                        </div>
                      </article>
                    ))}
                  </div>
                )}
              </fieldset>

              <fieldset className="settings-fieldset">
                <legend>기본 정보</legend>
                <label className="settings-field">
                  <span className="settings-field__label">이름</span>
                  <input
                    type="text"
                    className="settings-field__input"
                    value={draft.name}
                    disabled={saving}
                    onChange={(e) => updateDraft({ name: e.target.value })}
                  />
                  <span className="settings-field__hint">
                    pipeline을 구분할 표시 이름입니다. General 탭 "기본 Pipeline"과
                    thread 생성 화면의 pipeline 선택 목록에 노출됩니다.
                  </span>
                </label>
                <label className="settings-field">
                  <span className="settings-field__label">설명</span>
                  <textarea
                    className="settings-field__input settings-field__textarea settings-field__textarea--compact"
                    value={draft.description}
                    disabled={saving}
                    onChange={(e) =>
                      updateDraft({ description: e.target.value })
                    }
                  />
                  <span className="settings-field__hint">
                    어떤 요청 유형에 적합한 pipeline인지 한두 줄로. 추천 엔진의
                    매칭 점수 계산에도 입력으로 사용됩니다.
                  </span>
                </label>
              </fieldset>

              {visualModel !== null && (
                <fieldset
                  className={`settings-fieldset pipeline-visual-builder${
                    graphEditorOpen
                      ? " pipeline-visual-builder--window"
                      : ""
                  }`}
                  role={graphEditorOpen ? "dialog" : undefined}
                  aria-modal={graphEditorOpen ? true : undefined}
                  aria-label={
                    graphEditorOpen
                      ? "Pipeline graph editor"
                      : undefined
                  }
                >
                  <legend>Visual Pipeline Builder</legend>
                  <div className="pipeline-visual__toolbar">
                    <div className="pipeline-visual__summary">
                      <span>{visualModel.nodes.length} nodes</span>
                      <span>{visualModel.links.length} links</span>
                      <span>{(draft.backflowRules ?? []).length} backflows</span>
                    </div>
                    <div className="pipeline-visual__actions">
                      <button
                        type="button"
                        className="btn btn--ghost btn--sm"
                        disabled={saving || profiles.length === 0}
                        onClick={handleAddStep}
                      >
                        + node 추가
                      </button>
                      <button
                        type="button"
                        className="btn btn--ghost btn--sm"
                        disabled={saving || suggestedBackflowRules.length === 0}
                        onClick={handleAddSuggestedBackflows}
                      >
                        Backflow 자동 추가
                        {suggestedBackflowRules.length > 0
                          ? ` (${suggestedBackflowRules.length})`
                          : ""}
                      </button>
                      <button
                        type="button"
                        className="btn btn--primary btn--sm"
                        disabled={saving}
                        onClick={() => setGraphEditorOpen(true)}
                      >
                        그래프 창 열기
                      </button>
                      {graphEditorOpen && (
                        <button
                          type="button"
                          className="btn btn--ghost btn--sm"
                          onClick={() => setGraphEditorOpen(false)}
                        >
                          창 닫기
                        </button>
                      )}
                    </div>
                  </div>
                  <div
                    className="pipeline-visual__connection-bar"
                    aria-label="연결 모드"
                  >
                    <span>연결 모드</span>
                    <button
                      type="button"
                      className={`btn btn--ghost btn--sm${
                        visualConnection?.kind === "dependency"
                          ? " pipeline-visual__mode--active"
                          : ""
                      }`}
                      disabled={saving}
                      onClick={() => handleVisualConnectionMode("dependency")}
                    >
                      의존 연결
                    </button>
                    <button
                      type="button"
                      className={`btn btn--ghost btn--sm${
                        visualConnection?.kind === "step_failed"
                          ? " pipeline-visual__mode--active"
                          : ""
                      }`}
                      disabled={saving}
                      onClick={() => handleVisualConnectionMode("step_failed")}
                    >
                      실패 backflow
                    </button>
                    <button
                      type="button"
                      className={`btn btn--ghost btn--sm${
                        visualConnection?.kind === "quality_failed"
                          ? " pipeline-visual__mode--active"
                          : ""
                      }`}
                      disabled={saving}
                      onClick={() =>
                        handleVisualConnectionMode("quality_failed")
                      }
                    >
                      품질 backflow
                    </button>
                    <button
                      type="button"
                      className="btn btn--ghost btn--sm"
                      disabled={saving || visualConnection === null}
                      onClick={() => {
                        setVisualConnection(null);
                        setVisualConnectionMessage(null);
                      }}
                    >
                      취소
                    </button>
                    {visualConnection && (
                      <span className="pipeline-visual__connection-status">
                        {visualConnectionKindLabel(visualConnection.kind)} ·{" "}
                        {visualConnection.fromStepId
                          ? `${stepTitle(
                              draft.steps,
                              visualConnection.fromStepId,
                            )} → 대상 선택`
                          : "출발 node 선택"}
                      </span>
                    )}
                    {visualConnectionMessage && (
                      <span className="pipeline-visual__connection-status">
                        {visualConnectionMessage}
                      </span>
                    )}
                  </div>
                  <div className="pipeline-visual__workbench">
                    <div className="pipeline-visual__graph-shell">
                      {visualModel.nodes.length === 0 ||
                      visualGraphLayout === null ? (
                        <div className="empty-state">
                          첫 node를 추가하면 실행 순서와 backflow 연결이 그래프로 표시됩니다.
                        </div>
                      ) : (
                        <div
                          ref={visualGraphRef}
                          className="pipeline-visual__graph"
                          style={{
                            width: visualGraphLayout.width,
                            height: visualGraphLayout.height,
                          }}
                          aria-label="Visual pipeline node graph"
                          onPointerMove={handleVisualGraphPointerMove}
                          onPointerUp={handleVisualGraphPointerUp}
                          onPointerCancel={handleVisualGraphPointerUp}
                        >
                          <svg
                            className="pipeline-visual__edges"
                            viewBox={`0 0 ${visualGraphLayout.width} ${visualGraphLayout.height}`}
                            preserveAspectRatio="xMinYMin meet"
                            role="img"
                            aria-label="Pipeline graph edges"
                          >
                            <defs>
                              <marker
                                id="pipeline-arrow"
                                markerWidth="10"
                                markerHeight="10"
                                refX="8"
                                refY="5"
                                orient="auto"
                                markerUnits="strokeWidth"
                              >
                                <path d="M 0 0 L 10 5 L 0 10 z" />
                              </marker>
                              <marker
                                id="pipeline-backflow-arrow"
                                markerWidth="10"
                                markerHeight="10"
                                refX="8"
                                refY="5"
                                orient="auto"
                                markerUnits="strokeWidth"
                              >
                                <path d="M 0 0 L 10 5 L 0 10 z" />
                              </marker>
                            </defs>
                            {visualGraphLayout.edges.map((edge) => (
                              <g key={edge.link.id}>
                                <path
                                  className={`pipeline-visual__edge pipeline-visual__link--${edge.link.kind}`}
                                  d={edge.path}
                                  markerEnd={
                                    edge.link.kind === "dependency"
                                      ? "url(#pipeline-arrow)"
                                      : "url(#pipeline-backflow-arrow)"
                                  }
                                />
                                <text
                                  className="pipeline-visual__edge-label"
                                  x={edge.labelX}
                                  y={edge.labelY}
                                  textAnchor="middle"
                                >
                                  {edge.link.kind === "dependency"
                                    ? "depends"
                                    : edge.link.kind}
                                </text>
                              </g>
                            ))}
                            {visualLinkDrag &&
                              (() => {
                                const from = visualGraphLayout.nodes.find(
                                  (node) =>
                                    node.stepId === visualLinkDrag.fromStepId,
                                );
                                if (!from) return null;
                                const source = graphNodePortPoint(from, "out");
                                const dx = visualLinkDrag.x - source.x;
                                const dy = visualLinkDrag.y - source.y;
                                const curve = Math.min(
                                  240,
                                  Math.max(64, Math.hypot(dx, dy) * 0.34),
                                );
                                const path = `M ${source.x} ${source.y} C ${source.x + curve} ${source.y}, ${visualLinkDrag.x - curve} ${visualLinkDrag.y}, ${visualLinkDrag.x} ${visualLinkDrag.y}`;
                                return (
                                  <path
                                    className={`pipeline-visual__edge pipeline-visual__edge--preview pipeline-visual__link--${visualLinkDrag.kind}`}
                                    d={path}
                                    markerEnd={
                                      visualLinkDrag.kind === "dependency"
                                        ? "url(#pipeline-arrow)"
                                        : "url(#pipeline-backflow-arrow)"
                                    }
                                  />
                                );
                              })()}
                          </svg>
                          {visualGraphLayout.edges.map((edge) => (
                            <button
                              key={`${edge.link.id}:delete`}
                              type="button"
                              className="btn btn--ghost btn--sm pipeline-visual__edge-delete"
                              disabled={saving}
                              style={{
                                left: edge.labelX,
                                top: edge.labelY + 8,
                              }}
                              onClick={() => handleVisualLinkRemove(edge.link)}
                              aria-label={`${edge.link.fromStepId} ${edge.link.toStepId} 연결 삭제`}
                              title="연결 삭제"
                            >
                              ✕
                            </button>
                          ))}
                          {visualModel.nodes.map((node) => {
                            const step = draft.steps[node.index];
                            const layout = visualGraphLayout.nodes.find(
                              (item) => item.stepId === node.stepId,
                            );
                            if (!step || !layout) return null;
                            const selectedClass =
                              selectedVisualStepId === node.stepId
                                ? " pipeline-visual__graph-node--selected"
                                : "";
                            const connectionClass =
                              visualConnection?.fromStepId === node.stepId
                                ? " pipeline-visual__node--connection-source"
                                : visualConnection
                                  ? " pipeline-visual__node--connection-target"
                                  : "";
                            const draggingClass =
                              visualNodeDrag?.stepId === node.stepId
                                ? " pipeline-visual__graph-node--dragging"
                                : "";
                            const roleClass = visualRoleClass(
                              profileRole(step.agentProfileId),
                            );
                            return (
                              <article
                                key={node.stepId}
                                className={`pipeline-visual__node pipeline-visual__graph-node ${roleClass}${selectedClass}${connectionClass}${draggingClass}`}
                                style={{
                                  left: layout.x,
                                  top: layout.y,
                                  width: GRAPH_NODE_WIDTH,
                                  height: GRAPH_NODE_HEIGHT,
                                }}
                                onClick={() =>
                                  !visualConnection &&
                                  setSelectedVisualStepId(node.stepId)
                                }
                              >
                                <button
                                  type="button"
                                  className="pipeline-visual__node-port pipeline-visual__node-port--in"
                                  disabled={saving}
                                  onPointerUp={(event) =>
                                    handleVisualPortPointerUp(
                                      event,
                                      node.stepId,
                                    )
                                  }
                                  aria-label={`${node.title} input port`}
                                  title="입력 port"
                                />
                                <button
                                  type="button"
                                  className="pipeline-visual__node-port pipeline-visual__node-port--out"
                                  disabled={saving}
                                  onPointerDown={(event) =>
                                    handleVisualPortPointerDown(
                                      event,
                                      node.stepId,
                                    )
                                  }
                                  aria-label={`${node.title} output port`}
                                  title="출력 port에서 드래그해 연결"
                                />
                                <div
                                  className="pipeline-visual__graph-node-header"
                                  onPointerDown={(event) =>
                                    handleVisualNodeDragStart(
                                      event,
                                      node.stepId,
                                      layout,
                                    )
                                  }
                                  title="드래그해서 node 이동"
                                >
                                  <span className="pipeline-visual__node-index">
                                    {node.index + 1}
                                  </span>
                                  <strong>{node.title}</strong>
                                </div>
                                <button
                                  type="button"
                                  className="pipeline-visual__node-connect"
                                  disabled={saving}
                                  onClick={() =>
                                    handleVisualNodeClick(node.stepId)
                                  }
                                >
                                  {visualConnection
                                    ? visualConnection.fromStepId ===
                                      node.stepId
                                      ? "출발"
                                      : visualConnection.fromStepId
                                        ? "대상"
                                        : "출발 선택"
                                    : "선택"}
                                </button>
                                <div className="pipeline-visual__graph-node-meta">
                                  <span>{node.roleLabel}</span>
                                  <span>{node.remoteEndpointLabel}</span>
                                  <span>
                                    deps{" "}
                                    {node.dependencyIds.length > 0
                                      ? node.dependencyIds.length
                                      : 0}
                                  </span>
                                  <span>backflow {node.backflowRuleCount}</span>
                                </div>
                              </article>
                            );
                          })}
                        </div>
                      )}
                    </div>
                    <aside className="pipeline-visual__inspector">
                      {selectedVisualStep &&
                      selectedVisualStepIndex >= 0 ? (
                        <>
                          <header className="pipeline-visual__inspector-header">
                            <strong>
                              Node {selectedVisualStepIndex + 1}
                            </strong>
                            <button
                              type="button"
                              className="btn btn--ghost btn--sm"
                              onClick={() =>
                                document
                                  .getElementById(
                                    `pipeline-step-editor-${selectedVisualStep.id}`,
                                  )
                                  ?.scrollIntoView({ block: "center" })
                              }
                            >
                              상세 카드
                            </button>
                          </header>
                          <label className="pipeline-visual__node-control">
                            <span>Title</span>
                            <input
                              type="text"
                              className="settings-field__input"
                              value={selectedVisualStep.title}
                              disabled={saving}
                              onChange={(e) =>
                                updateStep(selectedVisualStepIndex, {
                                  title: e.target.value,
                                })
                              }
                            />
                          </label>
                          <label className="pipeline-visual__node-control">
                            <span>Profile</span>
                            <select
                              className="settings-field__input"
                              value={selectedVisualStep.agentProfileId}
                              disabled={saving}
                              onChange={(e) =>
                                updateStep(selectedVisualStepIndex, {
                                  agentProfileId: e.target.value,
                                })
                              }
                            >
                              {profiles.map((p) => (
                                <option key={p.id} value={p.id}>
                                  {p.name} - {roleOptionLabel(p.role)}
                                </option>
                              ))}
                              {!profiles.some(
                                (p) =>
                                  p.id === selectedVisualStep.agentProfileId,
                              ) && (
                                <option
                                  value={selectedVisualStep.agentProfileId}
                                >
                                  {profileName(
                                    selectedVisualStep.agentProfileId,
                                  )}
                                </option>
                              )}
                            </select>
                          </label>
                          <label className="pipeline-visual__node-control">
                            <span>Remote</span>
                            <select
                              className="settings-field__input"
                              value={selectedVisualStep.remoteEndpointId}
                              disabled={saving}
                              onChange={(e) =>
                                updateStep(selectedVisualStepIndex, {
                                  remoteEndpointId: e.target.value,
                                })
                              }
                            >
                              <option value="">Local CLI</option>
                              {selectableRemoteEntries.map((entry) => (
                                <option
                                  key={entry.endpoint.id}
                                  value={entry.endpoint.id}
                                >
                                  {entry.endpoint.name}
                                </option>
                              ))}
                              {selectedVisualStep.remoteEndpointId.length > 0 &&
                                !selectableRemoteEntries.some(
                                  (entry) =>
                                    entry.endpoint.id ===
                                    selectedVisualStep.remoteEndpointId,
                                ) && (
                                  <option
                                    value={selectedVisualStep.remoteEndpointId}
                                  >
                                    {remoteName(
                                      selectedVisualStep.remoteEndpointId,
                                    )}
                                  </option>
                                )}
                            </select>
                          </label>
                          <label className="pipeline-visual__node-control">
                            <span>Output</span>
                            <select
                              className="settings-field__input"
                              value={selectedVisualStep.outputContract}
                              disabled={saving}
                              onChange={(e) =>
                                updateStep(selectedVisualStepIndex, {
                                  outputContract: e.target
                                    .value as WorkerOutputContract | "",
                                })
                              }
                            >
                              <option value="">Role 기본값</option>
                              {PIPELINE_OUTPUT_CONTRACT_CHOICES.map(
                                (contract) => (
                                  <option key={contract} value={contract}>
                                    {contract}
                                  </option>
                                ),
                              )}
                            </select>
                          </label>
                          <div className="pipeline-visual__node-actions">
                            <span>Actions</span>
                            {PIPELINE_WORKER_ACTION_CHOICES.map((action) => (
                              <label
                                key={action}
                                className="pipeline-step__check"
                              >
                                <input
                                  type="checkbox"
                                  disabled={saving}
                                  checked={
                                    selectedVisualStep.allowedActions?.includes(
                                      action,
                                    ) ?? false
                                  }
                                  onChange={(e) =>
                                    toggleAllowedAction(
                                      selectedVisualStepIndex,
                                      action,
                                      e.target.checked,
                                    )
                                  }
                                />
                                <span>{action}</span>
                              </label>
                            ))}
                            <button
                              type="button"
                              className="btn btn--ghost btn--sm"
                              disabled={
                                saving ||
                                selectedVisualStep.allowedActions === null
                              }
                              onClick={() =>
                                updateStep(selectedVisualStepIndex, {
                                  allowedActions: null,
                                })
                              }
                            >
                              Role 기본값
                            </button>
                          </div>
                          <label className="pipeline-visual__node-control">
                            <span>Instruction</span>
                            <textarea
                              className="settings-field__input settings-field__textarea settings-field__textarea--compact"
                              rows={3}
                              value={selectedVisualStep.instruction}
                              disabled={saving}
                              onChange={(e) =>
                                updateStep(selectedVisualStepIndex, {
                                  instruction: e.target.value,
                                })
                              }
                            />
                          </label>
                        </>
                      ) : (
                        <div className="empty-state">
                          그래프 node를 선택하면 설정 inspector가 열립니다.
                        </div>
                      )}
                    </aside>
                  </div>
                </fieldset>
              )}

              <fieldset className="settings-fieldset">
                <legend>Node settings</legend>
                <p className="settings-field__hint">
                  위 visual builder의 각 node를 상세 설정합니다. Agent Profile,
                  Remote Endpoint, Output Contract, dependency, allowed action,
                  instruction, backflow까지 이 카드 안에서 모두 조정할 수 있습니다.
                </p>
                {draft.steps.length === 0 && (
                  <p className="settings-field__hint">
                    위 "node 추가" 버튼으로 첫 node를 만드세요.
                  </p>
                )}
                <ol className="pipeline-steps">
                  {draft.steps.map((step, i) => {
                    const backflowCandidates = backflowTargetCandidates(
                      draft.steps,
                      step.id,
                    );
                    return (
                    <li
                      key={step.id}
                      id={`pipeline-step-editor-${step.id}`}
                      className="pipeline-step pipeline-step--visual-node"
                    >
                      <div className="pipeline-step__header">
                        <span className="pipeline-step__index">
                          {i + 1}
                        </span>
                        <input
                          type="text"
                          className="settings-field__input"
                          placeholder="Step 제목 (예: 계획 수립)"
                          value={step.title}
                          disabled={saving}
                          onChange={(e) =>
                            updateStep(i, { title: e.target.value })
                          }
                        />
                        <div className="pipeline-step__controls">
                          <button
                            type="button"
                            className="btn btn--ghost btn--sm"
                            disabled={saving || i === 0}
                            onClick={() => handleMoveStep(i, -1)}
                            aria-label={`${i + 1}번 step을 위로`}
                            title="위로"
                          >
                            ↑
                          </button>
                          <button
                            type="button"
                            className="btn btn--ghost btn--sm"
                            disabled={saving || i === draft.steps.length - 1}
                            onClick={() => handleMoveStep(i, 1)}
                            aria-label={`${i + 1}번 step을 아래로`}
                            title="아래로"
                          >
                            ↓
                          </button>
                          <button
                            type="button"
                            className="btn btn--ghost btn--sm btn--danger"
                            disabled={saving}
                            onClick={() => handleRemoveStep(i)}
                            aria-label={`${i + 1}번 step 삭제`}
                          >
                            ✕
                          </button>
                        </div>
                      </div>
                      <label className="settings-field">
                        <span className="settings-field__label">
                          Agent Profile
                        </span>
                        <select
                          className="settings-field__input"
                          value={step.agentProfileId}
                          disabled={saving}
                          onChange={(e) =>
                            updateStep(i, { agentProfileId: e.target.value })
                          }
                        >
                          {profiles.map((p) => (
                            <option key={p.id} value={p.id}>
                              {p.name} - {roleOptionLabel(p.role)}
                            </option>
                          ))}
                          {/* If the step references a profile not in the list
                              (e.g. dangling), surface it so the user can see
                              and fix the mismatch. */}
                          {!profiles.some(
                            (p) => p.id === step.agentProfileId,
                          ) && (
                            <option value={step.agentProfileId}>
                              {profileName(step.agentProfileId)}
                            </option>
                          )}
                        </select>
                        <span className="settings-field__hint">
                          {profileRoleDescription(step.agentProfileId)}
                        </span>
                      </label>
                      <label className="settings-field">
                        <span className="settings-field__label">
                          Remote A2A Endpoint
                        </span>
                        <select
                          className="settings-field__input"
                          value={step.remoteEndpointId}
                          disabled={saving}
                          onChange={(e) =>
                            updateStep(i, { remoteEndpointId: e.target.value })
                          }
                        >
                          <option value="">Local CLI</option>
                          {selectableRemoteEntries.map((entry) => (
                            <option
                              key={entry.endpoint.id}
                              value={entry.endpoint.id}
                            >
                              {entry.endpoint.name}
                            </option>
                          ))}
                          {step.remoteEndpointId.length > 0 &&
                            !selectableRemoteEntries.some(
                              (entry) =>
                                entry.endpoint.id === step.remoteEndpointId,
                            ) && (
                              <option value={step.remoteEndpointId}>
                                {remoteName(step.remoteEndpointId)}
                              </option>
                            )}
                        </select>
                        <span className="settings-field__hint">
                          Local CLI는 로컬 claude/codex 프로세스를 spawn합니다.
                          Remote endpoint를 고르면 위 Agent Profile 대신 해당 A2A
                          endpoint로 task가 위임됩니다.
                        </span>
                      </label>
                      <label className="settings-field">
                        <span className="settings-field__label">
                          Output Contract
                        </span>
                        <select
                          className="settings-field__input"
                          value={step.outputContract}
                          disabled={saving}
                          onChange={(e) =>
                            updateStep(i, {
                              outputContract: e.target
                                .value as WorkerOutputContract | "",
                            })
                          }
                        >
                          <option value="">Role 기본값</option>
                          {PIPELINE_OUTPUT_CONTRACT_CHOICES.map((contract) => (
                            <option key={contract} value={contract}>
                              {contract}
                            </option>
                          ))}
                        </select>
                        <span className="settings-field__hint">
                          이 step이 어떤 형식의 결과를 내야 하는지 강제합니다.
                          비워두면 Agent Profile의 role 기본 contract를 따릅니다.
                        </span>
                      </label>
                      <div className="settings-field">
                        <span className="settings-field__label">
                          의존 Step
                        </span>
                        <span className="settings-field__hint">
                          체크된 step들이 모두 완료되어야 이 step이 시작됩니다.
                          아무 것도 체크하지 않으면 step 순서대로 직렬 실행되고,
                          공통 의존성을 가진 step끼리는 병렬로 실행됩니다.
                        </span>
                        <div className="pipeline-step__option-grid">
                          {draft.steps
                            .filter((candidate) => candidate.id !== step.id)
                            .map((candidate) => (
                              <label
                                key={candidate.id}
                                className="pipeline-step__check"
                              >
                                <input
                                  type="checkbox"
                                  disabled={saving}
                                  checked={effectiveDependsOn(
                                    step,
                                    i,
                                  ).includes(candidate.id)}
                                  onChange={(e) =>
                                    toggleDependency(
                                      i,
                                      candidate.id,
                                      e.target.checked,
                                    )
                                  }
                                />
                                <span>
                                  {candidate.title.trim() || candidate.id}
                                </span>
                              </label>
                          ))}
                        </div>
                      </div>
                      <div className="settings-field">
                        <span className="settings-field__label">
                          Backflow 연결
                        </span>
                        <span className="settings-field__hint">
                          이 Agent가 실패하거나 품질 실패 후 재시도 대상이 될 때,
                          어느 이전 Agent로 되돌아가 보정할지 정합니다.
                        </span>
                        {backflowCandidates.length === 0 ? (
                          <span className="settings-field__hint">
                            연결된 upstream Agent가 없어 backflow를 설정할 수 없습니다.
                          </span>
                        ) : null}
                        <div className="pipeline-step__option-grid">
                          {(draft.backflowRules ?? [])
                            .map((rule, ruleIndex) => ({ rule, ruleIndex }))
                            .filter(({ rule }) => rule.retryStepId === step.id)
                            .map(({ rule, ruleIndex }) => {
                              const targetIsVisible = backflowCandidates.some(
                                (candidate) => candidate.id === rule.targetStepId,
                              );
                              return (
                                <div
                                  key={rule.id}
                                  className="pipeline-step__check"
                                >
                                  <label className="settings-field">
                                    <span className="settings-field__label">
                                      Trigger
                                    </span>
                                    <select
                                      className="settings-field__input"
                                      value={rule.trigger}
                                      disabled={saving}
                                      onChange={(e) =>
                                        updateBackflowRule(ruleIndex, {
                                          trigger: e.target
                                            .value as PipelineBackflowTrigger,
                                        })
                                      }
                                    >
                                      <option value="step_failed">
                                        step_failed
                                      </option>
                                      <option value="quality_failed">
                                        quality_failed
                                      </option>
                                    </select>
                                  </label>
                                  <label className="settings-field">
                                    <span className="settings-field__label">
                                      되돌아갈 Agent
                                    </span>
                                    <select
                                      className="settings-field__input"
                                      value={rule.targetStepId}
                                      disabled={saving}
                                      onChange={(e) =>
                                        updateBackflowRule(ruleIndex, {
                                          targetStepId: e.target.value,
                                          retryStepId: step.id,
                                        })
                                      }
                                    >
                                      {backflowCandidates.map((candidate) => (
                                        <option
                                          key={candidate.id}
                                          value={candidate.id}
                                        >
                                          {candidate.title.trim() ||
                                            candidate.id}
                                        </option>
                                      ))}
                                      {!targetIsVisible && (
                                        <option value={rule.targetStepId}>
                                          {stepTitle(draft.steps, rule.targetStepId)}
                                        </option>
                                      )}
                                    </select>
                                  </label>
                                  <label className="settings-field">
                                    <span className="settings-field__label">
                                      Max Attempts
                                    </span>
                                    <input
                                      type="number"
                                      min={1}
                                      max={5}
                                      className="settings-field__input"
                                      value={rule.maxAttempts}
                                      disabled={saving}
                                      onChange={(e) =>
                                        updateBackflowRule(ruleIndex, {
                                          maxAttempts: Number(e.target.value),
                                          retryStepId: step.id,
                                        })
                                      }
                                    />
                                  </label>
                                  <label className="settings-field">
                                    <span className="settings-field__label">
                                      Instruction
                                    </span>
                                    <textarea
                                      className="settings-field__input settings-field__textarea settings-field__textarea--compact"
                                      value={rule.instruction ?? ""}
                                      disabled={saving}
                                      onChange={(e) =>
                                        updateBackflowRule(ruleIndex, {
                                          instruction: e.target.value,
                                          retryStepId: step.id,
                                        })
                                      }
                                    />
                                  </label>
                                  <button
                                    type="button"
                                    className="btn btn--ghost btn--sm btn--danger"
                                    disabled={saving}
                                    onClick={() =>
                                      handleRemoveBackflowRule(ruleIndex)
                                    }
                                  >
                                    Backflow 삭제
                                  </button>
                                </div>
                              );
                            })}
                        </div>
                        <button
                          type="button"
                          className="btn btn--ghost btn--sm"
                          disabled={saving || backflowCandidates.length === 0}
                          onClick={() => handleAddBackflowRuleForStep(i)}
                        >
                          + 이 Agent에 backflow 연결
                        </button>
                      </div>
                      <div className="settings-field">
                        <span className="settings-field__label">
                          허용 Action
                        </span>
                        <span className="settings-field__hint">
                          이 step의 worker가 만들 수 있는 approval action 종류를 좁힙니다.
                          비워두면 Agent Profile role의 기본 허용 action을 그대로 사용합니다.
                        </span>
                        <div className="pipeline-step__option-row">
                          {PIPELINE_WORKER_ACTION_CHOICES.map((action) => (
                            <label
                              key={action}
                              className="pipeline-step__check"
                            >
                              <input
                                type="checkbox"
                                disabled={saving}
                                checked={
                                  step.allowedActions?.includes(action) ??
                                  false
                                }
                                onChange={(e) =>
                                  toggleAllowedAction(
                                    i,
                                    action,
                                    e.target.checked,
                                  )
                                }
                              />
                              <span>{action}</span>
                            </label>
                          ))}
                          <button
                            type="button"
                            className="btn btn--ghost btn--sm"
                            disabled={saving || step.allowedActions === null}
                            onClick={() =>
                              updateStep(i, { allowedActions: null })
                            }
                          >
                            Role 기본값
                          </button>
                        </div>
                      </div>
                      <label className="settings-field">
                        <span className="settings-field__label">
                          Instruction (이 step에 전달되는 프롬프트)
                        </span>
                        <textarea
                          className="settings-field__input settings-field__textarea"
                          rows={2}
                          value={step.instruction}
                          disabled={saving}
                          placeholder="예: 변경된 파일을 분석하고 위험 요소를 한국어로 정리하세요."
                          onChange={(e) =>
                            updateStep(i, { instruction: e.target.value })
                          }
                        />
                        <span className="settings-field__hint">
                          이 step의 worker prompt 본문입니다. 의존 step의 결과는
                          이 prompt 위에 자동으로 컨텍스트로 붙으므로 여기서는
                          "무엇을 결정/생성/검토할지"만 적으세요.
                        </span>
                      </label>
                    </li>
                    );
                  })}
                </ol>
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  disabled={saving || profiles.length === 0}
                  onClick={handleAddStep}
                >
                  + node 추가
                </button>
              </fieldset>

              {fanOutPreview !== null && draft.steps.length > 0 && (
                <fieldset className="settings-fieldset">
                  <legend>Fan-out 미리보기</legend>
                  <div className="pipeline-fanout__order">
                    <span>출력 순서</span>
                    <strong>{fanOutPreview.deterministicOrder.join(" -> ")}</strong>
                  </div>
                  {fanOutPreview.warnings.length > 0 && (
                    <ul className="pipeline-fanout__warnings">
                      {fanOutPreview.warnings.map((warning, i) => (
                        <li key={i}>{warning}</li>
                      ))}
                    </ul>
                  )}
                  <div className="pipeline-fanout__waves">
                    {fanOutPreview.waves.map((wave) => (
                      <article key={wave.index} className="pipeline-fanout__wave">
                        <header className="pipeline-fanout__wave-header">
                          <div>
                            <strong>Wave {wave.index + 1}</strong>
                            <span>
                              {wave.stepIds.length} step
                            </span>
                          </div>
                          <span
                            className={`pipeline-fanout__badge${
                              wave.parallelizable
                                ? " pipeline-fanout__badge--parallel"
                                : ""
                            }`}
                          >
                            {wave.parallelizable
                              ? "읽기 전용 병렬"
                              : "순차 실행"}
                          </span>
                        </header>
                        {wave.warnings.length > 0 && (
                          <ul className="pipeline-fanout__warnings">
                            {wave.warnings.map((warning, i) => (
                              <li key={i}>{warning}</li>
                            ))}
                          </ul>
                        )}
                        <ol className="pipeline-fanout__steps">
                          {wave.steps.map((step) => (
                            <li key={step.stepId}>
                              <div className="pipeline-fanout__step-title">
                                <strong>{step.title}</strong>
                                <span>{roleDisplay(step.role)}</span>
                              </div>
                              <div className="pipeline-fanout__step-meta">
                                <span>
                                  의존성:{" "}
                                  {step.dependencyIds.length > 0
                                    ? step.dependencyIds.join(", ")
                                    : "없음"}
                                </span>
                                <span>
                                  remote: {step.remoteEndpointLabel}
                                  {step.remoteEndpointId !== null
                                    ? step.remoteEndpointTrusted &&
                                      step.remoteEndpointEnabled
                                      ? " trusted"
                                      : " blocked"
                                    : ""}
                                </span>
                              </div>
                              {step.blockers.length > 0 && (
                                <ul className="pipeline-fanout__blockers">
                                  {step.blockers.map((blocker, i) => (
                                    <li key={i}>{blocker}</li>
                                  ))}
                                </ul>
                              )}
                            </li>
                          ))}
                        </ol>
                      </article>
                    ))}
                  </div>
                </fieldset>
              )}

              {validationErrors.length > 0 && (
                <div
                  className="pipelines-tab__errors"
                  role="alert"
                  style={{ color: "var(--status-failed)" }}
                >
                  <strong>저장 전 수정:</strong>
                  <ul>
                    {validationErrors.map((e, i) => (
                      <li key={i}>{e.message}</li>
                    ))}
                  </ul>
                </div>
              )}

              {error && (
                <div style={{ color: "var(--status-failed)", marginTop: 8 }}>
                  {error}
                </div>
              )}

              <div className="pipelines-tab__actions">
                <button
                  type="button"
                  className="btn btn--primary"
                  onClick={() => void handleSave()}
                  disabled={saving || validationErrors.length > 0}
                >
                  {saving
                    ? "저장 중…"
                    : draft.id === null
                      ? "생성"
                      : "저장"}
                </button>
                {draft.id !== null && (
                  <button
                    type="button"
                    className="btn btn--ghost"
                    onClick={() => void handleSetDefaultPipeline()}
                    disabled={saving || draft.id === defaultPipelineId}
                  >
                    {draft.id === defaultPipelineId
                      ? "기본 실행 pipeline"
                      : "기본 실행 pipeline으로 지정"}
                  </button>
                )}
                {draft.id !== null && (
                  <button
                    type="button"
                    className="btn btn--ghost btn--danger"
                    onClick={() => void handleDelete()}
                    disabled={saving}
                  >
                    삭제
                  </button>
                )}
              </div>
            </div>
          )}
        </section>
      </div>
    </div>
  );
};
