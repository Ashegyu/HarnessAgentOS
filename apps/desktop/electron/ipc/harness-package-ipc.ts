import {
  HARNESS_PACKAGE_NOT_FOUND,
  STATE_INVALID_INPUT,
  err,
  harnessError,
  ok,
  type HarnessDefinition,
  type HarnessPackageImportDirectoryResult,
  type HarnessResult,
} from "@harness/core";
import type { HarnessPackageService } from "@harness/orchestration";

export interface HarnessPackageIpcContext {
  harnessPackages: Pick<
    HarnessPackageService,
    "listPackages" | "getPackage" | "importDirectory" | "removePackage"
  >;
}

const wrap = async <T>(fn: () => Promise<T>): Promise<HarnessResult<T>> => {
  try {
    return ok(await fn());
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return err(harnessError(STATE_INVALID_INPUT, msg));
  }
};

const requiredString = (
  input: unknown,
  field: string,
): { ok: true; value: string } | { ok: false; reason: string } => {
  const value =
    typeof input === "object" && input !== null
      ? (input as Record<string, unknown>)[field]
      : undefined;
  if (typeof value !== "string" || value.trim().length === 0) {
    return { ok: false, reason: `${field} is required` };
  }
  return { ok: true, value: value.trim() };
};

export const buildHarnessPackageHandlers = (
  ctx: HarnessPackageIpcContext,
) => {
  const { harnessPackages } = ctx;
  return {
    list: async (): Promise<HarnessResult<HarnessDefinition[]>> =>
      wrap(() => harnessPackages.listPackages()),

    get: async (input: {
      packageId: string;
    }): Promise<HarnessResult<HarnessDefinition>> => {
      const id = requiredString(input, "packageId");
      if (!id.ok) return err(harnessError(STATE_INVALID_INPUT, id.reason));
      const found = await harnessPackages.getPackage(id.value);
      if (!found) {
        return err(
          harnessError(
            HARNESS_PACKAGE_NOT_FOUND,
            `unknown harness package: ${id.value}`,
          ),
        );
      }
      return ok(found);
    },

    importDirectory: async (input: {
      rootDir: string;
    }): Promise<HarnessResult<HarnessPackageImportDirectoryResult>> => {
      const rootDir = requiredString(input, "rootDir");
      if (!rootDir.ok) {
        return err(harnessError(STATE_INVALID_INPUT, rootDir.reason));
      }
      return wrap(() =>
        harnessPackages.importDirectory({ rootDir: rootDir.value }),
      );
    },

    remove: async (input: {
      packageId: string;
    }): Promise<HarnessResult<void>> => {
      const id = requiredString(input, "packageId");
      if (!id.ok) return err(harnessError(STATE_INVALID_INPUT, id.reason));
      const found = await harnessPackages.getPackage(id.value);
      if (!found) {
        return err(
          harnessError(
            HARNESS_PACKAGE_NOT_FOUND,
            `unknown harness package: ${id.value}`,
          ),
        );
      }
      return wrap(async () => {
        await harnessPackages.removePackage(id.value);
      });
    },
  };
};

export type HarnessPackageIpcHandlers = ReturnType<
  typeof buildHarnessPackageHandlers
>;
