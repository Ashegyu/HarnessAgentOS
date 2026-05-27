import type { HarnessDefinition } from "@harness/core";
import type { LocalStateService } from "@harness/storage";
import {
  importHarnessPackageFromDirectory,
  type ImportHarnessPackageFromDirectoryInput,
} from "./harness-directory-import.ts";
import type { HarnessSourceDetectionResult } from "./harness-source-detection.ts";
import type { ImportHarnessPackageResult } from "./harness-import.ts";

export type HarnessPackageImportAndSaveResult =
  | {
      ok: true;
      definition: HarnessDefinition;
      detection: HarnessSourceDetectionResult;
    }
  | Extract<ImportHarnessPackageResult, { ok: false }>;

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
}
