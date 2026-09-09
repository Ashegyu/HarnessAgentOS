import type {
  QualityGateInput,
  QualityGateResult,
  QualityGateStatus,
  TaskRun,
  Artifact,
} from "@harness/core";
import { collectEvidence } from "./evidence-reader.ts";
import { taskContractFor } from "@harness/core";
import { collectRisks } from "./risk-policy.ts";
import type { LocalStateService } from "@harness/storage";
import { newId, nowIso } from "@harness/storage";

export interface QualityEvaluatorDeps {
  state: LocalStateService;
  /** Optional host verifier for report-only file delivery; never model prose. */
  verifyReportDelivery?: (task: TaskRun, diffArtifacts: Artifact[]) => Promise<boolean>;
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
  private readonly deps: QualityEvaluatorDeps;

  constructor(deps: QualityEvaluatorDeps) {

    this.deps = deps;

  }

  async evaluate(input: QualityGateInput): Promise<QualityGateResult> {
    const taskRun = await this.deps.state.getTaskRun(input.taskRunId);
    if (!taskRun) {
      throw new Error(`TaskRun ${input.taskRunId} not found`);
    }
    const [steps, artifacts] = await Promise.all([
      this.deps.state.listStepsByTaskRun(input.taskRunId),
      this.deps.state.listArtifactsByTaskRun(input.taskRunId),
    ]);

    const currentSteps = steps.filter(step => step.taskRunId === taskRun.id);
    const currentArtifacts = artifacts.filter(artifact => artifact.taskRunId === taskRun.id);
    const evidence = collectEvidence(currentSteps, currentArtifacts);
    const changedArtifacts = currentArtifacts.filter(a => evidence.diffArtifactIds.includes(a.id));
    const reportDelivered = taskContractFor(taskRun).intent === "change" && changedArtifacts.length > 0 &&
      changedArtifacts.every(a => currentSteps.some(step => step.id === a.stepId && step.kind === "edit" && step.status === "succeeded")) &&
      await this.deps.verifyReportDelivery?.(taskRun, changedArtifacts) === true;
    const risks = collectRisks(evidence, {
      requireBuild: input.requireBuild,
      requireTests: input.requireTests,
      requireSmoke: input.requireSmoke,
      verifiedReportDelivery: reportDelivered,
    });

    let status = computeStatus(evidence, risks, input);
    const responseArtifactIds: string[] = [];
    const contract = taskContractFor(taskRun);
    if (contract.authorization.mode === "read_only") {
      const invocations = await this.deps.state.listAgentInvocationsByTaskRun(taskRun.id);
      const latest = [...invocations].filter(row => row.taskRunId === taskRun.id)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
      const response = latest?.status === "succeeded"
        ? currentArtifacts.find(artifact => artifact.id === latest.parsedPlanArtifactId &&
            artifact.kind === "plan" && (artifact.summary?.trim().length ?? 0) > 0 &&
            currentSteps.some(step => step.id === artifact.stepId && step.status === "succeeded"))
        : undefined;
      const changed = evidence.diffArtifactIds.length > 0 ||
        currentSteps.some(step => step.kind === "edit" && step.status === "succeeded");
      if (changed) {
        risks.push("읽기 전용 요청에서 변경 근거가 발견되었습니다.");
        status = "failed";
      } else if (!response) {
        risks.push("성공한 최신 모델 호출에 연결된 최종 응답 근거가 없습니다.");
        if (status !== "failed") status = "not_run";
      } else {
        responseArtifactIds.push(response.id);
        // This validates response delivery and scope, not the truth of arbitrary
        // claims. Source-based review/diagnosis/research needs content acceptance.
        if (contract.intent !== "answer" || contract.origin === "legacy") {
          risks.push("응답 생성은 끝났습니다. 인용 자료와 내용의 타당성은 사용자 확인이 필요합니다.");
        }
        if (status !== "failed") status = risks.length > 0 ? "warning" : "passed";
      }
    } else if (contract.intent === "change" && evidence.diffArtifactIds.length === 0) {
      risks.push("수정 요청에 대응하는 실제 변경 근거가 없습니다.");
      if (status !== "failed") status = "warning";
    }

    const result: QualityGateResult = {
      id: newId("qualityGate"),
      taskRunId: input.taskRunId,
      status,
      knownRisks: risks,
      evidenceArtifactIds: [...new Set([...collectEvidenceArtifactIds(evidence), ...responseArtifactIds])],
      createdAt: nowIso(),
    };
    if (evidence.buildEvidence.length > 0) {
      result.buildPassed = evidence.buildEvidence.every((e) => e.passed);
    }
    if (evidence.testEvidence.length > 0) {
      result.testsPassed = evidence.testEvidence.every((e) => e.passed);
    }
    if (evidence.smokeEvidence.length > 0) {
      result.smokePassed = evidence.smokeEvidence.every((e) => e.passed);
    }
    if (evidence.diffArtifactIds.length > 0) {
      result.changedFilesReviewed = false;
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
    evidence.smokeEvidence.length > 0 ||
    evidence.diffArtifactIds.length > 0;

  if (!requestedSomething && !hasAnyEvidence) return "not_run";
  if (
    evidence.testEvidence.some((e) => !e.passed) ||
    evidence.buildEvidence.some((e) => !e.passed) ||
    evidence.smokeEvidence.some((e) => !e.passed)
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
  smokeEvidence: { passed: boolean; artifactId?: string }[];
  diffArtifactIds: string[];
}): string[] => {
  const ids: string[] = [];
  for (const e of evidence.testEvidence) {
    if (e.artifactId) ids.push(e.artifactId);
  }
  for (const e of evidence.buildEvidence) {
    if (e.artifactId) ids.push(e.artifactId);
  }
  for (const e of evidence.smokeEvidence) {
    if (e.artifactId) ids.push(e.artifactId);
  }
  for (const id of evidence.diffArtifactIds) ids.push(id);
  return Array.from(new Set(ids));
};
