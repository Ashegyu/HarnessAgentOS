import {
  APPROVAL_ACTION_TYPES,
  HARNESS_PROVIDER_HINTS,
  HARNESS_BINDING_SET_NOT_FOUND,
  HARNESS_PACKAGE_NOT_FOUND,
  STATE_INVALID_INPUT,
  WORKER_OUTPUT_CONTRACTS,
  err,
  harnessError,
  ok,
  type AgentProviderStatusMap,
  type ApprovalActionType,
  type CreateHarnessBindingSetInput,
  type CreateHarnessPackageInput,
  type HarnessAgentProfileBinding,
  type HarnessBindingSet,
  type HarnessBindingSetListInput,
  type HarnessDefinition,
  type HarnessPackageExportPreview,
  type HarnessPackageExportPreviewInput,
  type HarnessPackageExportProposalInput,
  type HarnessPackageExportProposalResult,
  type HarnessPackageImportDirectoryResult,
  type HarnessPackageRepairInput,
  type HarnessPackageRepairResult,
  type HarnessPipelineDraftPreviewResult,
  type HarnessResult,
  type HarnessProviderHint,
  type WorkerOutputContract,
} from "@harness/core";
import { type HarnessPackageService } from "@harness/orchestration";

export interface HarnessPackageIpcContext {
  harnessPackages: Pick<
    HarnessPackageService,
    | "listPackages"
    | "getPackage"
    | "createPackage"
    | "importDirectory"
    | "removePackage"
    | "repairPackage"
    | "previewExportPackage"
    | "proposeExportPackage"
    | "previewPipelineDraft"
    | "listBindingSets"
    | "getBindingSet"
    | "saveBindingSet"
    | "removeBindingSet"
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

const parseBindingSetListInput = (
  input: unknown,
):
  | { ok: true; value: HarnessBindingSetListInput }
  | { ok: false; reason: string } => {
  if (input === undefined || input === null) return { ok: true, value: {} };
  if (typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, reason: "input must be an object" };
  }
  const packageId = optionalString(input, "packageId");
  if (!packageId.ok) return { ok: false, reason: packageId.reason };
  const workflowId = optionalString(input, "workflowId");
  if (!workflowId.ok) return { ok: false, reason: workflowId.reason };
  return {
    ok: true,
    value: {
      ...(packageId.value !== undefined ? { packageId: packageId.value } : {}),
      ...(workflowId.value !== undefined ? { workflowId: workflowId.value } : {}),
    },
  };
};

const parseCreatePackageInput = (
  input: unknown,
):
  | { ok: true; value: CreateHarnessPackageInput }
  | { ok: false; reason: string } => {
  const raw =
    typeof input === "object" && input !== null
      ? (input as Record<string, unknown>).package
      : undefined;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, reason: "package must be an object" };
  }
  const name = requiredString(raw, "name");
  if (!name.ok) return { ok: false, reason: name.reason };
  const description = optionalString(raw, "description");
  if (!description.ok) return { ok: false, reason: description.reason };
  const workflowName = requiredString(raw, "workflowName");
  if (!workflowName.ok) return { ok: false, reason: workflowName.reason };
  const agentRef = requiredString(raw, "agentRef");
  if (!agentRef.ok) return { ok: false, reason: agentRef.reason };
  const agentName = optionalString(raw, "agentName");
  if (!agentName.ok) return { ok: false, reason: agentName.reason };
  const agentDescription = optionalString(raw, "agentDescription");
  if (!agentDescription.ok) {
    return { ok: false, reason: agentDescription.reason };
  }
  const agentPersona = optionalString(raw, "agentPersona");
  if (!agentPersona.ok) return { ok: false, reason: agentPersona.reason };
  const stepTitle = requiredString(raw, "stepTitle");
  if (!stepTitle.ok) return { ok: false, reason: stepTitle.reason };
  const stepInstruction = requiredString(raw, "stepInstruction");
  if (!stepInstruction.ok) {
    return { ok: false, reason: stepInstruction.reason };
  }
  const outputContract = optionalString(raw, "outputContract");
  if (!outputContract.ok) {
    return { ok: false, reason: outputContract.reason };
  }
  if (
    outputContract.value !== undefined &&
    !WORKER_OUTPUT_CONTRACTS.includes(
      outputContract.value as WorkerOutputContract,
    )
  ) {
    return { ok: false, reason: "outputContract is invalid" };
  }
  const providerHint = optionalString(raw, "providerHint");
  if (!providerHint.ok) return { ok: false, reason: providerHint.reason };
  if (
    providerHint.value !== undefined &&
    !HARNESS_PROVIDER_HINTS.includes(providerHint.value as HarnessProviderHint)
  ) {
    return { ok: false, reason: "providerHint is invalid" };
  }
  const allowedActions = parseAllowedActions(raw);
  if (!allowedActions.ok) return { ok: false, reason: allowedActions.reason };
  return {
    ok: true,
    value: {
      name: name.value,
      ...(description.value !== undefined
        ? { description: description.value }
        : {}),
      workflowName: workflowName.value,
      agentRef: agentRef.value,
      ...(agentName.value !== undefined ? { agentName: agentName.value } : {}),
      ...(agentDescription.value !== undefined
        ? { agentDescription: agentDescription.value }
        : {}),
      ...(agentPersona.value !== undefined
        ? { agentPersona: agentPersona.value }
        : {}),
      stepTitle: stepTitle.value,
      stepInstruction: stepInstruction.value,
      ...(outputContract.value !== undefined
        ? {
            outputContract:
              outputContract.value as WorkerOutputContract,
          }
        : {}),
      ...(providerHint.value !== undefined
        ? {
            providerHint:
              providerHint.value as HarnessProviderHint,
          }
        : {}),
      ...(allowedActions.value !== undefined
        ? { allowedActions: allowedActions.value }
        : {}),
    },
  };
};

const parseAllowedActions = (
  input: unknown,
):
  | { ok: true; value?: CreateHarnessPackageInput["allowedActions"] }
  | { ok: false; reason: string } => {
  const raw =
    typeof input === "object" && input !== null
      ? (input as Record<string, unknown>).allowedActions
      : undefined;
  if (raw === undefined) return { ok: true };
  if (!Array.isArray(raw)) {
    return { ok: false, reason: "allowedActions must be an array" };
  }
  const out: ApprovalActionType[] = [];
  for (const [index, value] of raw.entries()) {
    if (
      typeof value !== "string" ||
      !APPROVAL_ACTION_TYPES.includes(value as ApprovalActionType)
    ) {
      return {
        ok: false,
        reason: `allowedActions[${index}] is invalid`,
      };
    }
    out.push(value as ApprovalActionType);
  }
  return { ok: true, value: out };
};

const parseBindingSetInput = (
  input: unknown,
):
  | { ok: true; value: CreateHarnessBindingSetInput | HarnessBindingSet }
  | { ok: false; reason: string } => {
  const raw =
    typeof input === "object" && input !== null
      ? (input as Record<string, unknown>).bindingSet
      : undefined;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, reason: "bindingSet must be an object" };
  }
  const packageId = requiredString(raw, "packageId");
  if (!packageId.ok) return { ok: false, reason: packageId.reason };
  const workflowId = requiredString(raw, "workflowId");
  if (!workflowId.ok) return { ok: false, reason: workflowId.reason };
  const name = requiredString(raw, "name");
  if (!name.ok) return { ok: false, reason: name.reason };
  const bindings = parseProfileBindings(raw);
  if (!bindings.ok) return { ok: false, reason: bindings.reason };
  const record = raw as Record<string, unknown>;
  const value: CreateHarnessBindingSetInput | HarnessBindingSet = {
    ...(typeof record.id === "string" && record.id.trim().length > 0
      ? { id: record.id.trim() }
      : {}),
    packageId: packageId.value,
    workflowId: workflowId.value,
    name: name.value,
    bindings: bindings.value,
    ...(typeof record.createdAt === "string" && record.createdAt.length > 0
      ? { createdAt: record.createdAt }
      : {}),
    ...(typeof record.updatedAt === "string" && record.updatedAt.length > 0
      ? { updatedAt: record.updatedAt }
      : {}),
  } as CreateHarnessBindingSetInput | HarnessBindingSet;
  return { ok: true, value };
};

const parseProviderStatusMap = (
  input: unknown,
):
  | { ok: true; value?: AgentProviderStatusMap }
  | { ok: false; reason: string } => {
  const rawProviders =
    typeof input === "object" && input !== null
      ? (input as Record<string, unknown>).providers
      : undefined;
  if (rawProviders === undefined) return { ok: true };
  if (typeof rawProviders !== "object" || rawProviders === null) {
    return { ok: false, reason: "providers must be an object" };
  }
  const providers = rawProviders as Record<string, unknown>;
  const codex = parseProviderProbe(providers.codex, "providers.codex");
  if (!codex.ok) return { ok: false, reason: codex.reason };
  return {
    ok: true,
    value: {
      codex: codex.value,
    },
  };
};

const parseProviderProbe = (
  value: unknown,
  field: string,
):
  | { ok: true; value: AgentProviderStatusMap["codex"] }
  | { ok: false; reason: string } => {
  if (typeof value !== "object" || value === null) {
    return { ok: false, reason: `${field} must be an object` };
  }
  const raw = value as Record<string, unknown>;
  if (typeof raw.available !== "boolean") {
    return { ok: false, reason: `${field}.available must be a boolean` };
  }
  if (
    typeof raw.queueDepth !== "number" ||
    !Number.isInteger(raw.queueDepth) ||
    raw.queueDepth < 0
  ) {
    return {
      ok: false,
      reason: `${field}.queueDepth must be a non-negative integer`,
    };
  }
  for (const optionalField of ["version", "error", "command"] as const) {
    if (
      raw[optionalField] !== undefined &&
      typeof raw[optionalField] !== "string"
    ) {
      return {
        ok: false,
        reason: `${field}.${optionalField} must be a string when provided`,
      };
    }
  }
  return {
    ok: true,
    value: {
      available: raw.available,
      queueDepth: raw.queueDepth,
      ...(typeof raw.version === "string" ? { version: raw.version } : {}),
      ...(typeof raw.error === "string" ? { error: raw.error } : {}),
      ...(typeof raw.command === "string" ? { command: raw.command } : {}),
    },
  };
};

const parseRepairInput = (
  input: unknown,
): { ok: true; value: HarnessPackageRepairInput } | { ok: false; reason: string } => {
  const packageId = requiredString(input, "packageId");
  if (!packageId.ok) return { ok: false, reason: packageId.reason };
  const note = optionalString(input, "note");
  if (!note.ok) return { ok: false, reason: note.reason };
  const raw =
    typeof input === "object" && input !== null
      ? (input as Record<string, unknown>).workflows
      : undefined;
  if (!Array.isArray(raw) || raw.length === 0) {
    return { ok: false, reason: "workflows must be a non-empty array" };
  }
  return {
    ok: true,
    value: {
      packageId: packageId.value,
      ...(note.value !== undefined ? { note: note.value } : {}),
      workflows: raw as HarnessPackageRepairInput["workflows"],
    },
  };
};

const parseExportPreviewInput = (
  input: unknown,
):
  | { ok: true; value: HarnessPackageExportPreviewInput }
  | { ok: false; reason: string } => {
  const packageId = requiredString(input, "packageId");
  if (!packageId.ok) return { ok: false, reason: packageId.reason };
  const targetFormat = requiredString(input, "targetFormat");
  if (!targetFormat.ok) return { ok: false, reason: targetFormat.reason };
  if (
    targetFormat.value !== "claude" &&
    targetFormat.value !== "codex" &&
    targetFormat.value !== "harness-native"
  ) {
    return { ok: false, reason: "targetFormat is invalid" };
  }
  return {
    ok: true,
    value: {
      packageId: packageId.value,
      targetFormat: targetFormat.value,
    },
  };
};

const parseExportProposalInput = (
  input: unknown,
):
  | { ok: true; value: HarnessPackageExportProposalInput }
  | { ok: false; reason: string } => {
  const preview = parseExportPreviewInput(input);
  if (!preview.ok) return preview;
  const targetDir = requiredString(input, "targetDir");
  if (!targetDir.ok) return { ok: false, reason: targetDir.reason };
  return {
    ok: true,
    value: {
      ...preview.value,
      targetDir: targetDir.value,
    },
  };
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

    create: async (input: {
      package: CreateHarnessPackageInput;
    }): Promise<HarnessResult<HarnessDefinition>> => {
      const parsed = parseCreatePackageInput(input);
      if (!parsed.ok) {
        return err(harnessError(STATE_INVALID_INPUT, parsed.reason));
      }
      return wrap(() => harnessPackages.createPackage(parsed.value));
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

    repair: async (
      input: HarnessPackageRepairInput,
    ): Promise<HarnessResult<HarnessPackageRepairResult>> => {
      const parsed = parseRepairInput(input);
      if (!parsed.ok) {
        return err(harnessError(STATE_INVALID_INPUT, parsed.reason));
      }
      const found = await harnessPackages.getPackage(parsed.value.packageId);
      if (!found) {
        return err(
          harnessError(
            HARNESS_PACKAGE_NOT_FOUND,
            `unknown harness package: ${parsed.value.packageId}`,
          ),
        );
      }
      return wrap(() => harnessPackages.repairPackage(parsed.value));
    },

    previewExport: async (
      input: HarnessPackageExportPreviewInput,
    ): Promise<HarnessResult<HarnessPackageExportPreview>> => {
      const parsed = parseExportPreviewInput(input);
      if (!parsed.ok) {
        return err(harnessError(STATE_INVALID_INPUT, parsed.reason));
      }
      const found = await harnessPackages.getPackage(parsed.value.packageId);
      if (!found) {
        return err(
          harnessError(
            HARNESS_PACKAGE_NOT_FOUND,
            `unknown harness package: ${parsed.value.packageId}`,
          ),
        );
      }
      return wrap(() => harnessPackages.previewExportPackage(parsed.value));
    },

    proposeExport: async (
      input: HarnessPackageExportProposalInput,
    ): Promise<HarnessResult<HarnessPackageExportProposalResult>> => {
      const parsed = parseExportProposalInput(input);
      if (!parsed.ok) {
        return err(harnessError(STATE_INVALID_INPUT, parsed.reason));
      }
      const found = await harnessPackages.getPackage(parsed.value.packageId);
      if (!found) {
        return err(
          harnessError(
            HARNESS_PACKAGE_NOT_FOUND,
            `unknown harness package: ${parsed.value.packageId}`,
          ),
        );
      }
      return wrap(() => harnessPackages.proposeExportPackage(parsed.value));
    },

    previewPipelineDraft: async (input: {
      packageId: string;
      workflowId?: string;
      bindings: readonly HarnessAgentProfileBinding[];
      providers?: AgentProviderStatusMap;
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
      const providers = parseProviderStatusMap(input);
      if (!providers.ok) {
        return err(harnessError(STATE_INVALID_INPUT, providers.reason));
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
      return wrap(() =>
        harnessPackages.previewPipelineDraft({
          packageId: id.value,
          workflowId: workflowId.value,
          bindings: bindings.value,
          ...(providers.value !== undefined ? { providers: providers.value } : {}),
        }),
      );
    },

    listBindingSets: async (
      input?: HarnessBindingSetListInput,
    ): Promise<HarnessResult<HarnessBindingSet[]>> => {
      const parsed = parseBindingSetListInput(input);
      if (!parsed.ok) {
        return err(harnessError(STATE_INVALID_INPUT, parsed.reason));
      }
      return wrap(() => harnessPackages.listBindingSets(parsed.value));
    },

    getBindingSet: async (input: {
      bindingSetId: string;
    }): Promise<HarnessResult<HarnessBindingSet>> => {
      const id = requiredString(input, "bindingSetId");
      if (!id.ok) return err(harnessError(STATE_INVALID_INPUT, id.reason));
      const found = await harnessPackages.getBindingSet(id.value);
      if (!found) {
        return err(
          harnessError(
            HARNESS_BINDING_SET_NOT_FOUND,
            `unknown harness binding set: ${id.value}`,
          ),
        );
      }
      return ok(found);
    },

    saveBindingSet: async (input: {
      bindingSet: CreateHarnessBindingSetInput | HarnessBindingSet;
    }): Promise<HarnessResult<HarnessBindingSet>> => {
      const parsed = parseBindingSetInput(input);
      if (!parsed.ok) {
        return err(harnessError(STATE_INVALID_INPUT, parsed.reason));
      }
      const found = await harnessPackages.getPackage(parsed.value.packageId);
      if (!found) {
        return err(
          harnessError(
            HARNESS_PACKAGE_NOT_FOUND,
            `unknown harness package: ${parsed.value.packageId}`,
          ),
        );
      }
      return wrap(() => harnessPackages.saveBindingSet(parsed.value));
    },

    removeBindingSet: async (input: {
      bindingSetId: string;
    }): Promise<HarnessResult<void>> => {
      const id = requiredString(input, "bindingSetId");
      if (!id.ok) return err(harnessError(STATE_INVALID_INPUT, id.reason));
      return wrap(async () => {
        await harnessPackages.removeBindingSet(id.value);
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
