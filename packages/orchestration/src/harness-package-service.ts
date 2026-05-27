import type {
  HarnessDefinition,
  HarnessPackageExportPreview,
  HarnessPackageExportPreviewInput,
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
