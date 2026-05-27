import { WORKER_OUTPUT_CONTRACTS } from "@harness/core";
import type {
  Approval,
  AgentProviderStatusMap,
  CreateHarnessBindingSetInput,
  CreateHarnessPackageInput,
  HarnessAgentProfileBinding,
  HarnessBindingSet,
  HarnessBindingSetListInput,
  HarnessBindingReadinessSummary,
  HarnessDefinition,
  HarnessPackageExportPreview,
  HarnessPackageExportPreviewInput,
  HarnessPackageExportProposalInput,
  HarnessPackageExportProposalResult,
  HarnessPackageImportDirectoryResult,
  HarnessPipelineDraftIssue,
  HarnessPipelineDraftPreviewResult,
  HarnessPackageRepairInput,
  HarnessPackageRepairResult,
} from "@harness/core";
import type { LocalStateService } from "@harness/storage";
import { newId, nowIso } from "@harness/storage";
import {
  importHarnessPackageFromDirectory,
  type ImportHarnessPackageFromDirectoryInput,
} from "./harness-directory-import.ts";
import { assessHarnessBindingReadiness } from "./harness-binding-readiness.ts";
import { exportHarnessPackage } from "./harness-package-export.ts";
import { applyHarnessPackageRepair } from "./harness-package-repair.ts";
import { convertHarnessWorkflowToPipelineDraft } from "./harness-pipeline-draft.ts";

export type HarnessPackageImportAndSaveResult =
  HarnessPackageImportDirectoryResult;

const DIRECT_CREATE_ADAPTER_VERSION = "harness-direct-create-v1";
const DIRECT_CREATE_ROOT_DIR = "harness://manual";
const DIRECT_CREATE_SOURCE_FILE = "manual/harness.json";

export interface HarnessPackageServiceDeps {
  state: LocalStateService;
}

export interface HarnessPackagePipelinePreviewInput {
  packageId: string;
  workflowId?: string;
  bindings: readonly HarnessAgentProfileBinding[];
  providers?: AgentProviderStatusMap;
}

export class HarnessPackageService {
  private readonly deps: HarnessPackageServiceDeps;

  constructor(deps: HarnessPackageServiceDeps) {
    this.deps = deps;
  }

  async importDirectory(
    input: ImportHarnessPackageFromDirectoryInput,
  ): Promise<HarnessPackageImportAndSaveResult> {
    const result = await importHarnessPackageFromDirectory(input);
    if (!result.ok) return result;
    const saved = await this.deps.state.harnessPackages.save(result.definition);
    return {
      ok: true,
      definition: saved,
      detection: result.detection,
    };
  }

  async createPackage(
    input: CreateHarnessPackageInput,
  ): Promise<HarnessDefinition> {
    const createdAt = nowIso();
    const definition = buildDirectHarnessDefinition(input, createdAt);
    return this.deps.state.harnessPackages.save(definition);
  }

  async listPackages(): Promise<HarnessDefinition[]> {
    return this.deps.state.harnessPackages.list();
  }

  async getPackage(id: string): Promise<HarnessDefinition | null> {
    return this.deps.state.harnessPackages.get(id);
  }

  async listBindingSets(
    input?: HarnessBindingSetListInput,
  ): Promise<HarnessBindingSet[]> {
    return this.deps.state.harnessBindingSets.list(input);
  }

  async getBindingSet(id: string): Promise<HarnessBindingSet | null> {
    return this.deps.state.harnessBindingSets.get(id);
  }

  async saveBindingSet(
    input: CreateHarnessBindingSetInput | HarnessBindingSet,
  ): Promise<HarnessBindingSet> {
    const found = await this.getPackage(input.packageId);
    if (!found) {
      throw new Error(`unknown harness package: ${input.packageId}`);
    }
    if (!found.workflows.some((workflow) => workflow.id === input.workflowId)) {
      throw new Error(
        `unknown harness workflow: ${input.packageId}/${input.workflowId}`,
      );
    }
    const readiness = await this.assessBindingReadiness({
      packageId: input.packageId,
      workflowId: input.workflowId,
      bindings: input.bindings,
    });
    if (!readiness.ok) {
      throw new Error(
        readiness.issues
          .filter((issue) => issue.severity === "error")
          .map((issue) => `${issue.code}: ${issue.message}`)
          .join("; ") || "Harness binding set is not ready",
      );
    }
    return this.deps.state.harnessBindingSets.save(input);
  }

  async removeBindingSet(id: string): Promise<void> {
    await this.deps.state.harnessBindingSets.remove(id);
  }

  async removePackage(id: string): Promise<void> {
    await this.deps.state.harnessPackages.remove(id);
  }

  async previewExportPackage(
    input: HarnessPackageExportPreviewInput,
  ): Promise<HarnessPackageExportPreview> {
    const found = await this.getPackage(input.packageId);
    if (!found) {
      throw new Error(`unknown harness package: ${input.packageId}`);
    }
    return exportHarnessPackage({
      definition: found,
      targetFormat: input.targetFormat,
    });
  }

  async assessBindingReadiness(
    input: HarnessPackagePipelinePreviewInput,
  ): Promise<HarnessBindingReadinessSummary> {
    const found = await this.getPackage(input.packageId);
    if (!found) {
      throw new Error(`unknown harness package: ${input.packageId}`);
    }
    const [profiles, mcpServers, skillSources, capabilities] = await Promise.all([
      this.deps.state.agentProfiles.list(),
      this.deps.state.mcpServers.list(),
      this.deps.state.skillSources.list(),
      this.deps.state.capabilities.list(),
    ]);
    return assessHarnessBindingReadiness({
      definition: found,
      workflowId: input.workflowId ?? null,
      bindings: bindingRecord(input.bindings),
      profiles,
      ...(input.providers !== undefined ? { providers: input.providers } : {}),
      mcpServers,
      skillSources,
      capabilities,
    });
  }

  async previewPipelineDraft(
    input: HarnessPackagePipelinePreviewInput,
  ): Promise<HarnessPipelineDraftPreviewResult> {
    const found = await this.getPackage(input.packageId);
    if (!found) {
      throw new Error(`unknown harness package: ${input.packageId}`);
    }
    const readiness = await this.assessBindingReadiness(input);
    if (!readiness.ok) {
      return {
        ok: false,
        readiness,
        issues: readiness.issues
          .filter((issue) => issue.severity === "error")
          .map(readinessIssueToPipelineIssue),
      };
    }
    const preview = convertHarnessWorkflowToPipelineDraft({
      definition: found,
      workflowId: input.workflowId,
      bindings: input.bindings,
    });
    if (!preview.ok) {
      return { ...preview, readiness };
    }
    return {
      ok: true,
      workflowId: preview.workflow.id,
      pipeline: preview.pipeline,
      issues: preview.issues,
      readiness,
    };
  }

  async proposeExportPackage(
    input: HarnessPackageExportProposalInput,
  ): Promise<HarnessPackageExportProposalResult> {
    const preview = await this.previewExportPackage(input);
    for (const file of preview.files) assertSafeExportPath(file.relativePath);

    const thread = await this.deps.state.createThread({
      title: "Harness package export",
      targetDir: input.targetDir,
    });
    const taskRun = await this.deps.state.createTaskRun({
      threadId: thread.id,
      userRequest: `Export ${preview.packageName} as ${preview.targetFormat}`,
      targetDir: input.targetDir,
    });
    const step = await this.deps.state.createStep({
      taskRunId: taskRun.id,
      index: 0,
      kind: "approval",
      title: "Harness package export approval",
      status: "pending",
      inputSummary: `${preview.files.length} declaration files for ${preview.targetFormat}`,
    });
    const checkpoint = await this.deps.state.createCheckpoint({
      taskRunId: taskRun.id,
      stepId: step.id,
      reason: "manual",
      stateRef: JSON.stringify({
        kind: "harness_package_export",
        packageId: preview.packageId,
        targetFormat: preview.targetFormat,
        fileCount: preview.files.length,
      }),
      summary: `Export ${preview.packageName} as ${preview.targetFormat}`,
    });
    await this.deps.state.setTaskRunCurrentStep(taskRun.id, step.id);
    const approvals: Approval[] = [];
    for (const file of preview.files) {
      approvals.push(
        await this.deps.state.createApproval({
          taskRunId: taskRun.id,
          checkpointId: checkpoint.id,
          actionType: "file_write",
          actionSummary: `Export ${file.relativePath}`,
          proposedAction: {
            type: "file_write",
            filePatch: {
              path: file.relativePath,
              after: file.content,
            },
          },
        }),
      );
    }
    const waiting = await this.deps.state.setTaskRunStatus(
      taskRun.id,
      "waiting_for_approval",
    );
    return {
      preview,
      thread,
      taskRun: waiting,
      checkpoint,
      approvals,
      targetDir: input.targetDir,
    };
  }

  async repairPackage(
    input: HarnessPackageRepairInput,
  ): Promise<HarnessPackageRepairResult> {
    const found = await this.getPackage(input.packageId);
    if (!found) {
      throw new Error(`unknown harness package: ${input.packageId}`);
    }
    const repaired = applyHarnessPackageRepair({
      ...input,
      definition: found,
      repairedAt: nowIso(),
    });
    const saved = await this.deps.state.harnessPackages.save(
      repaired.definition,
    );
    return {
      ...repaired,
      definition: saved,
    };
  }
}

const assertSafeExportPath = (relativePath: string): void => {
  if (
    relativePath.length === 0 ||
    relativePath.startsWith("/") ||
    /^[a-zA-Z]:/.test(relativePath) ||
    relativePath.split(/[\\/]+/).some((segment) => segment === "..")
  ) {
    throw new Error(`unsafe export path: ${relativePath}`);
  }
};

const buildDirectHarnessDefinition = (
  input: CreateHarnessPackageInput,
  createdAt: string,
): HarnessDefinition => {
  const name = requiredTrimmed(input.name, "name");
  const description = optionalTrimmed(input.description);
  const workflowName = requiredTrimmed(input.workflowName, "workflowName");
  const agentRef = slugFromText(requiredTrimmed(input.agentRef, "agentRef"));
  if (agentRef.length === 0) throw new Error("agentRef is required");
  const agentName = optionalTrimmed(input.agentName) ?? titleFromId(agentRef);
  const agentDescription = optionalTrimmed(input.agentDescription) ?? "";
  const stepTitle = requiredTrimmed(input.stepTitle, "stepTitle");
  const stepInstruction = requiredTrimmed(
    input.stepInstruction,
    "stepInstruction",
  );
  const outputContract = input.outputContract ?? "plan";
  if (!WORKER_OUTPUT_CONTRACTS.includes(outputContract)) {
    throw new Error("outputContract is invalid");
  }
  const allowedActions = input.allowedActions ?? [];
  const packageId = newId("harnessPackage");
  const workflowId = `${slugFromText(workflowName)}-workflow`;
  const skillId = `${slugFromText(workflowName)}-skill`;
  const phaseId = "phase-1";
  const stepId = `${slugFromText(stepTitle)}-step`;
  const summary = description ?? `Harness-native workflow: ${workflowName}.`;

  return {
    id: packageId,
    name,
    source: {
      format: "harness-native",
      rootDir: DIRECT_CREATE_ROOT_DIR,
      importedAt: createdAt,
      files: [
        {
          relativePath: DIRECT_CREATE_SOURCE_FILE,
          kind: "manifest",
          sha256: "synthetic-direct-create",
          parserVersion: DIRECT_CREATE_ADAPTER_VERSION,
        },
      ],
    },
    overview: {
      title: name,
      summary,
      usage: "Created directly in HarnessAgentOS.",
      outputPolicy: "Worker output must satisfy the selected step contract.",
    },
    agents: [
      {
        id: agentRef,
        name: agentName,
        description: agentDescription,
        roleHint: agentRef,
        sourceFile: DIRECT_CREATE_SOURCE_FILE,
        persona:
          optionalTrimmed(input.agentPersona) ??
          `You are the ${agentName} worker for ${name}.`,
        responsibilities: [stepInstruction],
        ...(input.providerHint !== undefined
          ? { providerHint: input.providerHint }
          : {}),
        requiredCapabilities: [],
      },
    ],
    skills: [
      {
        id: skillId,
        name: workflowName,
        description: summary,
        triggerTerms: uniqueNonEmpty([name, workflowName, agentRef]),
        negativeTriggerTerms: [],
        sourceFile: DIRECT_CREATE_SOURCE_FILE,
        workflowRefs: [workflowId],
        relatedSkillRefs: [],
        rawFrontmatter: { generatedBy: DIRECT_CREATE_ADAPTER_VERSION },
      },
    ],
    workflows: [
      {
        id: workflowId,
        skillId,
        name: workflowName,
        mode: "sequential",
        description: summary,
        sourceFile: DIRECT_CREATE_SOURCE_FILE,
        phases: [
          {
            id: phaseId,
            title: "Execution",
            owner: "agent",
            summary: "Run the starter workflow step.",
          },
        ],
        steps: [
          {
            id: stepId,
            title: stepTitle,
            agentRef,
            roleHint: agentRef,
            phaseId,
            instruction: stepInstruction,
            dependsOn: [],
            artifactContracts: [],
            allowedActions: [...allowedActions],
            outputContract,
            sourceRef: {
              relativePath: DIRECT_CREATE_SOURCE_FILE,
              heading: stepTitle,
            },
          },
        ],
        handoffPolicy: {
          mode: "structured_handoff",
          routes: [],
          requiredPayload: "harness_worker_handoff_v1",
          fallback: "pause_for_review",
        },
        failurePolicy: {
          defaultMode: "pause_for_review",
          maxAttempts: 1,
          rules: [],
        },
        testScenarios: [],
        parseConfidence: "high",
      },
    ],
    capabilities: [],
    validation: {
      status: "valid",
      issues: [],
      importedAt: createdAt,
      adapterVersion: DIRECT_CREATE_ADAPTER_VERSION,
    },
  };
};

const requiredTrimmed = (value: string, field: string): string => {
  const trimmed = value.trim();
  if (trimmed.length === 0) throw new Error(`${field} is required`);
  return trimmed;
};

const optionalTrimmed = (value: string | undefined): string | undefined => {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const uniqueNonEmpty = (values: readonly string[]): string[] => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (trimmed.length === 0 || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
};

const slugFromText = (value: string): string =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "manual";

const titleFromId = (id: string): string =>
  id
    .split(/[-_]+/)
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");

const bindingRecord = (
  bindings: readonly HarnessAgentProfileBinding[],
): Readonly<Record<string, string>> => {
  const out: Record<string, string> = {};
  for (const binding of bindings) {
    if (out[binding.harnessAgentRef] === undefined) {
      out[binding.harnessAgentRef] = binding.agentProfileId;
    }
  }
  return out;
};

const readinessIssueToPipelineIssue = (
  issue: HarnessBindingReadinessSummary["issues"][number],
): HarnessPipelineDraftIssue => ({
  severity: "error",
  code: "HARNESS_BINDING_READINESS_FAILED",
  message: issue.message,
  ...(issue.stepId !== undefined ? { stepId: issue.stepId } : {}),
});
