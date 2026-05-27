import {
  HARNESS_PACKAGE_NOT_FOUND,
  STATE_INVALID_INPUT,
  err,
  harnessError,
  ok,
  type HarnessAgentProfileBinding,
  type HarnessDefinition,
  type HarnessPackageImportDirectoryResult,
  type HarnessPipelineDraftPreviewResult,
  type HarnessResult,
} from "@harness/core";
import {
  convertHarnessWorkflowToPipelineDraft,
  type HarnessPackageService,
} from "@harness/orchestration";

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

const optionalString = (
  input: unknown,
  field: string,
): { ok: true; value?: string } | { ok: false; reason: string } => {
  const value =
    typeof input === "object" && input !== null
      ? (input as Record<string, unknown>)[field]
      : undefined;
  if (value === undefined) return { ok: true };
  if (typeof value !== "string") {
    return { ok: false, reason: `${field} must be a string` };
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return { ok: false, reason: `${field} must not be blank` };
  }
  return { ok: true, value: trimmed };
};

const parseProfileBindings = (
  input: unknown,
): { ok: true; value: HarnessAgentProfileBinding[] } | { ok: false; reason: string } => {
  const value =
    typeof input === "object" && input !== null
      ? (input as Record<string, unknown>).bindings
      : undefined;
  if (!Array.isArray(value)) {
    return { ok: false, reason: "bindings must be an array" };
  }
  const bindings: HarnessAgentProfileBinding[] = [];
  for (const [index, item] of value.entries()) {
    if (typeof item !== "object" || item === null) {
      return { ok: false, reason: `bindings[${index}] must be an object` };
    }
    const raw = item as Record<string, unknown>;
    if (
      typeof raw.harnessAgentRef !== "string" ||
      raw.harnessAgentRef.trim().length === 0
    ) {
      return {
        ok: false,
        reason: `bindings[${index}].harnessAgentRef is required`,
      };
    }
    if (
      typeof raw.agentProfileId !== "string" ||
      raw.agentProfileId.trim().length === 0
    ) {
      return {
        ok: false,
        reason: `bindings[${index}].agentProfileId is required`,
      };
    }
    if (
      raw.remoteEndpointId !== undefined &&
      (typeof raw.remoteEndpointId !== "string" ||
        raw.remoteEndpointId.trim().length === 0)
    ) {
      return {
        ok: false,
        reason: `bindings[${index}].remoteEndpointId must be a non-empty string when provided`,
      };
    }
    bindings.push({
      harnessAgentRef: raw.harnessAgentRef.trim(),
      agentProfileId: raw.agentProfileId.trim(),
      ...(typeof raw.remoteEndpointId === "string"
        ? { remoteEndpointId: raw.remoteEndpointId.trim() }
        : {}),
    });
  }
  return { ok: true, value: bindings };
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

    previewPipelineDraft: async (input: {
      packageId: string;
      workflowId?: string;
      bindings: readonly HarnessAgentProfileBinding[];
    }): Promise<HarnessResult<HarnessPipelineDraftPreviewResult>> => {
      const id = requiredString(input, "packageId");
      if (!id.ok) return err(harnessError(STATE_INVALID_INPUT, id.reason));
      const workflowId = optionalString(input, "workflowId");
      if (!workflowId.ok) {
        return err(harnessError(STATE_INVALID_INPUT, workflowId.reason));
      }
      const bindings = parseProfileBindings(input);
      if (!bindings.ok) {
        return err(harnessError(STATE_INVALID_INPUT, bindings.reason));
      }
      const found = await harnessPackages.getPackage(id.value);
      if (!found) {
        return err(
          harnessError(
            HARNESS_PACKAGE_NOT_FOUND,
            `unknown harness package: ${id.value}`,
          ),
        );
      }
      const preview = convertHarnessWorkflowToPipelineDraft({
        definition: found,
        workflowId: workflowId.value,
        bindings: bindings.value,
      });
      if (!preview.ok) return ok(preview);
      return ok({
        ok: true,
        workflowId: preview.workflow.id,
        pipeline: preview.pipeline,
        issues: preview.issues,
      });
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
