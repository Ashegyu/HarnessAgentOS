import { createHash } from "node:crypto";
import type {
  A2AEndpoint,
  A2ARemoteTaskRef,
  A2ARefinementAttempt,
  A2ARefinementProposal,
  AgentInvocation,
  Artifact,
  QualityGateResult,
  Step,
  TaskRun,
  WorkerStep,
} from "@harness/core";
import { evaluateA2ARefinementPolicy } from "@harness/agent";

export interface DeriveA2ARefinementProposalsInput {
  taskRun: TaskRun;
  steps: readonly Step[];
  artifacts: readonly Artifact[];
  qualityGates: readonly QualityGateResult[];
  agentInvocations: readonly AgentInvocation[];
  a2aRemoteTaskRefs: readonly A2ARemoteTaskRef[];
  a2aRefinementAttempts: readonly A2ARefinementAttempt[];
  a2aEndpoints: readonly A2AEndpoint[];
}

interface RemoteTarget {
  invocation: AgentInvocation;
  remoteRef: A2ARemoteTaskRef;
  endpoint: A2AEndpoint;
  workerStepId?: string;
}

interface PlanContext {
  workerSteps: WorkerStep[];
  workerStepIdByDbStepId: Map<string, string>;
}

export const deriveA2ARefinementProposals = (
  input: DeriveA2ARefinementProposalsInput,
): A2ARefinementProposal[] => {
  const planContext = buildPlanContext(input.artifacts, input.steps);
  const remoteTargets = buildRemoteTargets(input, planContext);
  if (remoteTargets.length === 0) return [];

  const proposals: A2ARefinementProposal[] = [];
  const seen = new Set<string>();
  const push = (proposal: A2ARefinementProposal | null): void => {
    if (!proposal || seen.has(proposal.id)) return;
    seen.add(proposal.id);
    proposals.push(proposal);
  };

  for (const proposal of deriveWorkerFindingProposals({
    input,
    planContext,
    remoteTargets,
  })) {
    push(proposal);
  }
  for (const proposal of deriveQualityGateProposals({
    input,
    planContext,
    remoteTargets,
  })) {
    push(proposal);
  }

  return proposals;
};

const deriveWorkerFindingProposals = (args: {
  input: DeriveA2ARefinementProposalsInput;
  planContext: PlanContext;
  remoteTargets: readonly RemoteTarget[];
}): A2ARefinementProposal[] => {
  const { input, planContext, remoteTargets } = args;
  const targetsByWorkerStepId = groupTargetsByWorkerStepId(remoteTargets);
  const invocationsByStepId = groupInvocationsByStepId(input.agentInvocations);
  const proposals: A2ARefinementProposal[] = [];

  planContext.workerSteps.forEach((workerStep, index) => {
    if (!isFindingWorkerStep(workerStep)) return;
    const sourceArtifacts = artifactsForWorkerStep(input.artifacts, workerStep.id);
    if (sourceArtifacts.length === 0) return;
    const sourceArtifact = sourceArtifacts[sourceArtifacts.length - 1]!;
    const sourceDbStepId = sourceArtifact.stepId;
    const sourceInvocation =
      sourceDbStepId !== undefined
        ? invocationsByStepId.get(sourceDbStepId)?.[0]
        : undefined;
    const dependencies = effectiveWorkerDependencyIds(
      planContext.workerSteps,
      index,
    );
    for (const dependencyId of dependencies) {
      for (const target of targetsByWorkerStepId.get(dependencyId) ?? []) {
        const proposal = buildProposal({
          input,
          sourceKind: "worker_finding",
          target,
          feedbackSourceKind: "worker",
          feedbackArtifact: sourceArtifact,
          referencedArtifactIds: [
            sourceArtifact.id,
            ...(target.invocation.rawOutputArtifactId
              ? [target.invocation.rawOutputArtifactId]
              : []),
          ],
          sourceLabel: `${workerStep.role}: ${workerStep.title}`,
          reason:
            "Reviewer/tester worker output maps to an upstream remote A2A invocation.",
          ...(sourceDbStepId ? { feedbackSourceStepId: sourceDbStepId } : {}),
          ...(sourceInvocation
            ? { feedbackSourceInvocationId: sourceInvocation.id }
            : {}),
          instruction: [
            "A downstream worker found an issue in the previous remote A2A result.",
            `Worker: ${workerStep.role} - ${workerStep.title}`,
            `Finding artifact: ${sourceArtifact.id}`,
            "",
            excerpt(sourceArtifact.summary ?? sourceArtifact.title),
            "",
            "Revise the previous remote result to address this finding. Return a revised answer only; do not assume any local file, shell, git, dependency, or network side effect has been approved.",
          ].join("\n"),
        });
        if (proposal) proposals.push(proposal);
      }
    }
  });

  return proposals;
};

const deriveQualityGateProposals = (args: {
  input: DeriveA2ARefinementProposalsInput;
  planContext: PlanContext;
  remoteTargets: readonly RemoteTarget[];
}): A2ARefinementProposal[] => {
  const { input, planContext, remoteTargets } = args;
  const targetsByArtifactId = mapTargetsByArtifactId(remoteTargets);
  const targetsByDbStepId = mapTargetsByDbStepId(remoteTargets);
  const artifactById = new Map(input.artifacts.map((a) => [a.id, a] as const));
  const proposals: A2ARefinementProposal[] = [];
  for (const gate of input.qualityGates) {
    if (gate.status !== "failed") continue;
    const emittedForGateTarget = new Set<string>();
    for (const evidenceArtifactId of gate.evidenceArtifactIds) {
      const evidence = artifactById.get(evidenceArtifactId);
      if (!evidence) continue;
      const candidates = targetsForEvidence({
        evidence,
        targetsByArtifactId,
        targetsByDbStepId,
      });
      for (const target of candidates) {
        const gateTargetKey = `${gate.id}:${target.invocation.id}`;
        if (emittedForGateTarget.has(gateTargetKey)) continue;
        emittedForGateTarget.add(gateTargetKey);
        const proposal = buildProposal({
          input,
          sourceKind: "quality_gate",
          target,
          feedbackSourceKind: "quality_gate",
          feedbackArtifact: evidence,
          qualityGateId: gate.id,
          referencedArtifactIds: [
            evidence.id,
            ...(target.invocation.rawOutputArtifactId
              ? [target.invocation.rawOutputArtifactId]
              : []),
          ],
          sourceLabel: `Quality gate ${gate.status}`,
          reason:
            "Failed quality gate evidence maps to a remote A2A invocation.",
          instruction: [
            "A quality gate failed for a result produced by this remote A2A invocation.",
            `Quality gate: ${gate.id}`,
            gate.knownRisks.length > 0
              ? `Known risks: ${gate.knownRisks.join("; ")}`
              : "Known risks: (none recorded)",
            `Evidence artifact: ${evidence.id}`,
            "",
            excerpt(evidence.summary ?? evidence.title),
            "",
            "Revise the previous remote result to address the failed quality evidence. Return a revised answer only; do not assume any local file, shell, git, dependency, or network side effect has been approved.",
          ].join("\n"),
        });
        if (proposal) proposals.push(proposal);
      }
    }
  }
  return proposals;
};

const buildProposal = (args: {
  input: DeriveA2ARefinementProposalsInput;
  sourceKind: A2ARefinementProposal["sourceKind"];
  target: RemoteTarget;
  feedbackSourceKind: A2ARefinementProposal["feedbackSourceKind"];
  feedbackSourceStepId?: string;
  feedbackSourceInvocationId?: string;
  feedbackArtifact?: Artifact;
  qualityGateId?: string;
  referencedArtifactIds: readonly string[];
  sourceLabel: string;
  reason: string;
  instruction: string;
}): A2ARefinementProposal | null => {
  const referencedArtifactIds = uniqueStrings(args.referencedArtifactIds);
  const request = {
    taskRunId: args.input.taskRun.id,
    targetInvocationId: args.target.invocation.id,
    feedbackSourceKind: args.feedbackSourceKind,
    ...(args.feedbackSourceStepId
      ? { feedbackSourceStepId: args.feedbackSourceStepId }
      : {}),
    ...(args.feedbackSourceInvocationId
      ? { feedbackSourceInvocationId: args.feedbackSourceInvocationId }
      : {}),
    ...(args.feedbackArtifact
      ? { feedbackArtifactId: args.feedbackArtifact.id }
      : {}),
    ...(args.qualityGateId ? { qualityGateId: args.qualityGateId } : {}),
    instruction: args.instruction,
    referencedArtifactIds,
  };
  const decision = evaluateA2ARefinementPolicy({
    request,
    existingAttempts: args.input.a2aRefinementAttempts,
    endpointAvailable: args.target.endpoint.enabled && args.target.endpoint.trusted,
  });
  if (!decision.ok) return null;
  return {
    id: proposalId({
      sourceKind: args.sourceKind,
      targetInvocationId: args.target.invocation.id,
      feedbackArtifactId: args.feedbackArtifact?.id,
      qualityGateId: args.qualityGateId,
      instruction: args.instruction,
    }),
    sourceKind: args.sourceKind,
    taskRunId: args.input.taskRun.id,
    targetInvocationId: args.target.invocation.id,
    endpointId: args.target.endpoint.id,
    feedbackSourceKind: args.feedbackSourceKind,
    ...(args.feedbackSourceStepId
      ? { feedbackSourceStepId: args.feedbackSourceStepId }
      : {}),
    ...(args.feedbackSourceInvocationId
      ? { feedbackSourceInvocationId: args.feedbackSourceInvocationId }
      : {}),
    ...(args.feedbackArtifact
      ? { feedbackArtifactId: args.feedbackArtifact.id }
      : {}),
    ...(args.qualityGateId ? { qualityGateId: args.qualityGateId } : {}),
    instruction: args.instruction,
    referencedArtifactIds,
    sourceLabel: args.sourceLabel,
    targetLabel: `${args.target.endpoint.name} -> ${args.target.invocation.id}`,
    reason: args.reason,
  };
};

const buildRemoteTargets = (
  input: DeriveA2ARefinementProposalsInput,
  planContext: PlanContext,
): RemoteTarget[] => {
  const remoteRefByInvocationId = new Map(
    input.a2aRemoteTaskRefs.map((ref) => [ref.invocationId, ref] as const),
  );
  const endpointById = new Map(
    input.a2aEndpoints.map((endpoint) => [endpoint.id, endpoint] as const),
  );
  return input.agentInvocations
    .map((invocation): RemoteTarget | null => {
      const remoteRef = remoteRefByInvocationId.get(invocation.id);
      if (!remoteRef) return null;
      const endpoint = endpointById.get(remoteRef.endpointId);
      if (!endpoint || !endpoint.enabled || !endpoint.trusted) return null;
      const workerStepId = invocation.stepId
        ? planContext.workerStepIdByDbStepId.get(invocation.stepId)
        : undefined;
      return {
        invocation,
        remoteRef,
        endpoint,
        ...(workerStepId ? { workerStepId } : {}),
      };
    })
    .filter((target): target is RemoteTarget => target !== null);
};

const buildPlanContext = (
  artifacts: readonly Artifact[],
  steps: readonly Step[],
): PlanContext => {
  const workerSteps = extractLatestWorkerSteps(artifacts);
  const workerStepIds = new Set(workerSteps.map((step) => step.id));
  const workerStepIdByDbStepId = new Map<string, string>();
  for (const artifact of artifacts) {
    if (!artifact.stepId) continue;
    const workerStepId = workerStepIdFromArtifactUri(artifact.uri);
    if (workerStepId === null || !workerStepIds.has(workerStepId)) continue;
    workerStepIdByDbStepId.set(artifact.stepId, workerStepId);
  }
  for (const step of steps) {
    if (workerStepIdByDbStepId.has(step.id)) continue;
    const workerStepId = inferWorkerStepIdFromDbStep(step, workerSteps);
    if (workerStepId !== null) workerStepIdByDbStepId.set(step.id, workerStepId);
  }
  return { workerSteps, workerStepIdByDbStepId };
};

const groupTargetsByWorkerStepId = (
  targets: readonly RemoteTarget[],
): Map<string, RemoteTarget[]> => {
  const result = new Map<string, RemoteTarget[]>();
  for (const target of targets) {
    if (!target.workerStepId) continue;
    const list = result.get(target.workerStepId) ?? [];
    list.push(target);
    result.set(target.workerStepId, list);
  }
  return result;
};

const groupInvocationsByStepId = (
  invocations: readonly AgentInvocation[],
): Map<string, AgentInvocation[]> => {
  const result = new Map<string, AgentInvocation[]>();
  for (const invocation of invocations) {
    if (!invocation.stepId) continue;
    const list = result.get(invocation.stepId) ?? [];
    list.push(invocation);
    result.set(invocation.stepId, list);
  }
  return result;
};

const mapTargetsByArtifactId = (
  targets: readonly RemoteTarget[],
): Map<string, RemoteTarget[]> => {
  const result = new Map<string, RemoteTarget[]>();
  for (const target of targets) {
    for (const artifactId of [
      target.invocation.promptArtifactId,
      target.invocation.rawOutputArtifactId,
    ]) {
      if (!artifactId) continue;
      const list = result.get(artifactId) ?? [];
      list.push(target);
      result.set(artifactId, list);
    }
  }
  return result;
};

const mapTargetsByDbStepId = (
  targets: readonly RemoteTarget[],
): Map<string, RemoteTarget[]> => {
  const result = new Map<string, RemoteTarget[]>();
  for (const target of targets) {
    const stepId = target.invocation.stepId;
    if (!stepId) continue;
    const list = result.get(stepId) ?? [];
    list.push(target);
    result.set(stepId, list);
  }
  return result;
};

const targetsForEvidence = (input: {
  evidence: Artifact;
  targetsByArtifactId: ReadonlyMap<string, readonly RemoteTarget[]>;
  targetsByDbStepId: ReadonlyMap<string, readonly RemoteTarget[]>;
}): RemoteTarget[] => {
  const byArtifact = input.targetsByArtifactId.get(input.evidence.id) ?? [];
  const byStep =
    input.evidence.stepId !== undefined
      ? input.targetsByDbStepId.get(input.evidence.stepId) ?? []
      : [];
  const byId = new Map<string, RemoteTarget>();
  for (const target of [...byArtifact, ...byStep]) {
    byId.set(target.invocation.id, target);
  }
  return [...byId.values()];
};

const artifactsForWorkerStep = (
  artifacts: readonly Artifact[],
  workerStepId: string,
): Artifact[] =>
  artifacts
    .filter((artifact) => workerStepIdFromArtifactUri(artifact.uri) === workerStepId)
    .sort((a, b) => artifactTime(a.createdAt) - artifactTime(b.createdAt));

const isFindingWorkerStep = (step: WorkerStep): boolean =>
  step.role === "reviewer" ||
  step.role === "tester" ||
  step.outputContract === "review" ||
  step.outputContract === "test_result";

const extractLatestWorkerSteps = (
  artifacts: readonly Artifact[],
): WorkerStep[] => {
  const planArtifacts = artifacts
    .map((artifact, index) => ({ artifact, index }))
    .filter(({ artifact }) => artifact.kind === "orchestration_plan")
    .sort((a, b) => {
      const byTime =
        artifactTime(a.artifact.createdAt) - artifactTime(b.artifact.createdAt);
      return byTime !== 0 ? byTime : a.index - b.index;
    });
  for (const { artifact } of planArtifacts.reverse()) {
    const workerSteps = parseWorkerStepsFromPlanSummary(artifact.summary ?? "");
    if (workerSteps.length > 0) return workerSteps;
  }
  return [];
};

const planJsonRe = /```json\s*([\s\S]+?)\s*```/;

const parseWorkerStepsFromPlanSummary = (summary: string): WorkerStep[] => {
  const match = planJsonRe.exec(summary);
  if (!match) return [];
  try {
    const parsed = JSON.parse(match[1] ?? "") as { workerSteps?: unknown };
    return Array.isArray(parsed.workerSteps)
      ? (parsed.workerSteps as WorkerStep[])
      : [];
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

const effectiveWorkerDependencyIds = (
  steps: readonly WorkerStep[],
  index: number,
): string[] => {
  const step = steps[index];
  if (!step) return [];
  if (step.dependsOn !== undefined) return [...step.dependsOn];
  return index > 0 ? [steps[index - 1]!.id] : [];
};

const uniqueStrings = (items: readonly string[]): string[] =>
  [...new Set(items.filter((item) => item.length > 0))];

const proposalId = (payload: {
  sourceKind: string;
  targetInvocationId: string;
  feedbackArtifactId?: string;
  qualityGateId?: string;
  instruction: string;
}): string =>
  `a2arprop_${createHash("sha256")
    .update(JSON.stringify(payload))
    .digest("hex")
    .slice(0, 16)}`;

const excerpt = (text: string, limit = 1_200): string => {
  const normalized = text.trim().replace(/\s+/g, " ");
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, limit - 3)}...`;
};

const artifactTime = (value: string): number => {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
};
