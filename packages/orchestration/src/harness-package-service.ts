import type {
  Approval,
  HarnessDefinition,
  HarnessPackageExportPreview,
  HarnessPackageExportPreviewInput,
  HarnessPackageExportProposalInput,
  HarnessPackageExportProposalResult,
  HarnessPackageImportDirectoryResult,
  HarnessPackageRepairInput,
  HarnessPackageRepairResult,
} from "@harness/core";
import type { LocalStateService } from "@harness/storage";
import { nowIso } from "@harness/storage";
import {
  importHarnessPackageFromDirectory,
  type ImportHarnessPackageFromDirectoryInput,
} from "./harness-directory-import.ts";
import { exportHarnessPackage } from "./harness-package-export.ts";
import { applyHarnessPackageRepair } from "./harness-package-repair.ts";

export type HarnessPackageImportAndSaveResult =
  HarnessPackageImportDirectoryResult;

export interface HarnessPackageServiceDeps {
  state: LocalStateService;
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

  async listPackages(): Promise<HarnessDefinition[]> {
    return this.deps.state.harnessPackages.list();
  }

  async getPackage(id: string): Promise<HarnessDefinition | null> {
    return this.deps.state.harnessPackages.get(id);
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
