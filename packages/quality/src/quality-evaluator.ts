import type {
  QualityGateInput,
  QualityGateResult,
  QualityGateStatus,
  TaskRun,
  Artifact,
} from "@harness/core";
import { collectEvidence } from "./evidence-reader.ts";
import { taskContractFor, regressionCheckerId, selectCurrentValidationEvidence } from "@harness/core";
import { collectRisks } from "./risk-policy.ts";
import type { LocalStateService } from "@harness/storage";
import { captureValidationRevision, newId, nowIso, type ValidationRevision } from "@harness/storage";

export interface QualityEvaluatorDeps {
  state: LocalStateService;
  /** Optional host verifier for report-only file delivery; never model prose. */
  verifyReportDelivery?: (task: TaskRun, diffArtifacts: Artifact[]) => Promise<boolean>;
  /** Tests may supply a deterministic manifest; production hashes actual inputs. */
  captureRevision?: (targetDir: string) => Promise<ValidationRevision>;
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
    const contract = taskContractFor(taskRun);
    const regressions = await this.deps.state.regressionContracts?.list(taskRun.id) ?? [];
    const additionalPaths = regressions.flatMap(c => [...c.sourcePaths,...c.verificationPaths,...c.sharedSources.map(s => s.path)]);
    const capture = this.deps.captureRevision ?? ((targetDir: string) => captureValidationRevision(targetDir,{additionalPaths}));
    const watermark = await this.deps.state.validationRuns?.getWatermark(input.taskRunId) ?? 0;
    const [steps, artifacts, runs] = await Promise.all([
      this.deps.state.listStepsByTaskRun(input.taskRunId),
      this.deps.state.listArtifactsByTaskRun(input.taskRunId),
      this.deps.state.validationRuns?.listByTaskRun(input.taskRunId) ?? Promise.resolve([]),
    ]);

    const currentSteps = steps.filter(step => step.taskRunId === taskRun.id);
    const currentArtifacts = artifacts.filter(artifact => artifact.taskRunId === taskRun.id);
    const currentRuns = runs.filter(run => run.taskRunId === taskRun.id);
    // A delivered read-only response claims no code validation. Preserve that
    // contract without imposing filesystem availability on ordinary answers.
    const needsWorkspaceValidation = contract.authorization.mode !== "read_only" ||
      input.requireBuild === true || input.requireTests === true || input.requireSmoke === true ||
      currentRuns.length > 0 || currentArtifacts.some(artifact => artifact.kind === "diff") ||
      currentSteps.some(step => step.kind === "edit");
    const captureWorkspace = needsWorkspaceValidation && typeof taskRun.targetDir === "string";
    const revision = captureWorkspace
      ? await capture(taskRun.targetDir)
      : { workspaceKey: "", fingerprint: null };
    const epoch = captureWorkspace
      ? await this.deps.state.workspaceMutations?.get(revision.workspaceKey) ?? { generation: 0, activeMutations: 0 }
      : { generation: 0, activeMutations: 0 };
    const evidence = collectEvidence(currentSteps, currentArtifacts, currentRuns, { ...revision, ...epoch });
    const changedArtifacts = currentArtifacts.filter(a => evidence.diffArtifactIds.includes(a.id));
    const reportDelivered = contract.intent === "change" && changedArtifacts.length > 0 &&
      changedArtifacts.every(a => currentSteps.some(step => step.id === a.stepId && step.kind === "edit" && step.status === "succeeded")) &&
      await this.deps.verifyReportDelivery?.(taskRun, changedArtifacts) === true;
    const finalRevision = captureWorkspace
      ? await capture(taskRun.targetDir)
      : revision;
    const finalEpoch = captureWorkspace ? await this.deps.state.workspaceMutations?.get(revision.workspaceKey) ?? epoch : epoch;
    const finalWatermark = await this.deps.state.validationRuns?.getWatermark(input.taskRunId) ?? watermark;
    const changedDuringEvaluation = finalRevision.workspaceKey !== revision.workspaceKey ||
      finalRevision.fingerprint !== revision.fingerprint || finalEpoch.generation !== epoch.generation ||
      finalEpoch.activeMutations !== epoch.activeMutations || finalWatermark !== watermark;
    if (changedDuringEvaluation) {
      evidence.buildEvidence.length = 0;
      evidence.testEvidence.length = 0;
      evidence.smokeEvidence.length = 0;
      (evidence.unverifiedReasons ??= []).push("validation inputs or execution results changed during evaluation; evaluate again");
    }
    const risks = collectRisks(evidence, {
      requireBuild: input.requireBuild,
      requireTests: input.requireTests,
      requireSmoke: input.requireSmoke,
      verifiedReportDelivery: reportDelivered,
    });

    let status = computeStatus(evidence, risks, input);
    const responseArtifactIds: string[] = [];
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

    if (regressions.length > 0) {
      const verified = selectCurrentValidationEvidence({ taskRunId: taskRun.id, runs: currentRuns, steps: currentSteps,
        artifacts: currentArtifacts, current: { ...revision, ...epoch } }).runs;
      for (const regression of regressions) {
        const run = !changedDuringEvaluation && verified.find(r => r.checkerId === regressionCheckerId(regression.id));
        if (!run || !regression.protectedVerification) {
          risks.push(`회귀 검사 최신 실행 필요: ${regression.title}`);
          if (status !== "failed") status = "not_run";
        } else if (run.status !== "completed" || run.exitCode !== 0) {
          risks.push(`회귀 검사 실패: ${regression.title}`);
          status = "failed";
        }
      }
    }

    const result: QualityGateResult = {
      id: newId("qualityGate"),
      taskRunId: input.taskRunId,
      status,
      knownRisks: risks,
      evidenceArtifactIds: [...new Set([...collectEvidenceArtifactIds(evidence), ...responseArtifactIds])],
      createdAt: nowIso(),
      ...(captureWorkspace ? { validationState: {
        workspaceKey: revision.workspaceKey, fingerprint: revision.fingerprint,
        generation: epoch.generation, watermark,
      } } : {}),
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

    return this.deps.state.createQualityGateResult(result);
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
