import type {
  QualityGateInput,
  QualityGateResult,
  QualityGateStatus,
} from "@harness/core";
import { collectEvidence } from "./evidence-reader";
import { collectRisks } from "./risk-policy";
import type { LocalStateService } from "@harness/storage";
import { newId, nowIso } from "@harness/storage";

export interface QualityEvaluatorDeps {
  state: LocalStateService;
}

/**
 * Phase 4 evaluator. Pulls steps + artifacts from LocalStateService,
 * classifies evidence with EvidenceReader, computes a deterministic
 * QualityGateStatus, then persists the result via the
 * QualityGateRepository.
 *
 * Does NOT mutate the TaskRun status itself; that is the
 * task-run-completion-service's job.
 */
export class QualityEvaluator {
  constructor(private readonly deps: QualityEvaluatorDeps) {}

  async evaluate(input: QualityGateInput): Promise<QualityGateResult> {
    const taskRun = await this.deps.state.getTaskRun(input.taskRunId);
    if (!taskRun) {
      throw new Error(`TaskRun ${input.taskRunId} not found`);
    }
    const [steps, artifacts] = await Promise.all([
      this.deps.state.listStepsByTaskRun(input.taskRunId),
      this.deps.state.listArtifactsByTaskRun(input.taskRunId),
    ]);

    const evidence = collectEvidence(steps, artifacts);
    const risks = collectRisks(evidence, {
      requireBuild: input.requireBuild,
      requireTests: input.requireTests,
      requireSmoke: input.requireSmoke,
    });

    const status = computeStatus(evidence, risks, input);

    const result: QualityGateResult = {
      id: newId("qualityGate"),
      taskRunId: input.taskRunId,
      status,
      knownRisks: risks,
      evidenceArtifactIds: collectEvidenceArtifactIds(evidence),
      createdAt: nowIso(),
    };
    if (evidence.buildEvidence.length > 0) {
      result.buildPassed = evidence.buildEvidence.every((e) => e.passed);
    }
    if (evidence.testEvidence.length > 0) {
      result.testsPassed = evidence.testEvidence.every((e) => e.passed);
    }
    if (input.requireSmoke && evidence.testEvidence.length > 0) {
      result.smokePassed = evidence.testEvidence.some((e) => e.passed);
    }
    if (evidence.diffArtifactIds.length > 0) {
      result.changedFilesReviewed = true;
    }

    await this.deps.state.createQualityGateResult(result);
    return result;
  }
}

const computeStatus = (
  evidence: Parameters<typeof collectRisks>[0],
  risks: string[],
  input: QualityGateInput,
): QualityGateStatus => {
  const requestedSomething =
    input.requireBuild === true ||
    input.requireTests === true ||
    input.requireSmoke === true;

  const hasAnyEvidence =
    evidence.testEvidence.length > 0 ||
    evidence.buildEvidence.length > 0 ||
    evidence.diffArtifactIds.length > 0;

  if (!requestedSomething && !hasAnyEvidence) return "not_run";
  if (
    evidence.testEvidence.some((e) => !e.passed) ||
    evidence.buildEvidence.some((e) => !e.passed)
  ) {
    return "failed";
  }
  if (risks.length > 0) return "warning";
  if (hasAnyEvidence) return "passed";
  return "not_run";
};

const collectEvidenceArtifactIds = (evidence: {
  testEvidence: { passed: boolean; artifactId?: string }[];
  buildEvidence: { passed: boolean; artifactId?: string }[];
  diffArtifactIds: string[];
}): string[] => {
  const ids: string[] = [];
  for (const e of evidence.testEvidence) {
    if (e.artifactId) ids.push(e.artifactId);
  }
  for (const e of evidence.buildEvidence) {
    if (e.artifactId) ids.push(e.artifactId);
  }
  for (const id of evidence.diffArtifactIds) ids.push(id);
  return Array.from(new Set(ids));
};
