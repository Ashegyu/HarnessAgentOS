import { ipcMain } from "electron";
import {
  DEFAULT_HARNESS_SETTINGS,
  IPC_CHANNELS,
  ORCHESTRATION_MODES,
  STATE_INVALID_INPUT,
  err,
  harnessError,
  ok,
  type AgentProvider,
  type HarnessResult,
  type HarnessSettings,
  type OrchestrationMode,
  type WorkerProfile,
} from "@harness/core";
import type { LocalStateService } from "@harness/storage";

const VALID_PROVIDERS: AgentProvider[] = ["auto", "claude", "codex"];

const isValidProvider = (v: unknown): v is AgentProvider =>
  VALID_PROVIDERS.includes(v as AgentProvider);

const validateSettingsInput = (
  raw: unknown,
): { ok: true; value: HarnessSettings } | { ok: false; reason: string } => {
  if (typeof raw !== "object" || raw === null) {
    return { ok: false, reason: "settings must be an object" };
  }
  const s = raw as Record<string, unknown>;
  if (typeof s.agent !== "object" || s.agent === null) {
    return { ok: false, reason: "settings.agent must be an object" };
  }
  const a = s.agent as Record<string, unknown>;
  if (!isValidProvider(a.provider)) {
    return {
      ok: false,
      reason: `agent.provider must be one of: ${VALID_PROVIDERS.join(", ")}`,
    };
  }
  if (typeof a.model !== "string") {
    return { ok: false, reason: "agent.model must be a string" };
  }
  if (typeof a.timeoutMs !== "number" || a.timeoutMs <= 0) {
    return { ok: false, reason: "agent.timeoutMs must be a positive number" };
  }
  if (typeof a.stallTimeoutMs !== "number" || a.stallTimeoutMs <= 0) {
    return {
      ok: false,
      reason: "agent.stallTimeoutMs must be a positive number",
    };
  }
  if (
    typeof a.contextDepth !== "number" ||
    !Number.isInteger(a.contextDepth) ||
    a.contextDepth < 1
  ) {
    return {
      ok: false,
      reason: "agent.contextDepth must be a positive integer",
    };
  }
  const codexWorkspaceWrite =
    typeof a.codexWorkspaceWrite === "boolean" ? a.codexWorkspaceWrite : false;
  const codexAutoReview =
    typeof a.codexAutoReview === "boolean" ? a.codexAutoReview : false;
  const orch =
    s.orchestration !== null && typeof s.orchestration === "object"
      ? (s.orchestration as Record<string, unknown>)
      : {};
  const orchestrationEnabled =
    typeof orch.enabled === "boolean" ? orch.enabled : false;
  const orchestrationMode: OrchestrationMode =
    typeof orch.defaultMode === "string" &&
    (ORCHESTRATION_MODES as readonly string[]).includes(orch.defaultMode)
      ? (orch.defaultMode as OrchestrationMode)
      : "single_worker";
  const orchestrationInstructions =
    typeof orch.defaultInstructions === "string" ? orch.defaultInstructions : "";
  const workerProfiles: WorkerProfile[] = Array.isArray(orch.workerProfiles)
    ? (orch.workerProfiles as WorkerProfile[])
    : [];
  // Empty string is the documented "no default" sentinel (see
  // OrchestrationSettings.defaultPipelineId). When the referenced pipeline
  // is deleted the UI also treats this row as empty, so coercing unknown
  // values down to "" is the safe normalization.
  const defaultPipelineId =
    typeof orch.defaultPipelineId === "string" ? orch.defaultPipelineId : "";
  const ap =
    s.approval !== null && typeof s.approval === "object"
      ? (s.approval as Record<string, unknown>)
      : {};
  const autoApprove =
    typeof ap.autoApprove === "boolean" ? ap.autoApprove : false;
  const workerFileAutoExecutionConfigured =
    typeof ap.workerFileAutoExecutionConfigured === "boolean"
      ? ap.workerFileAutoExecutionConfigured
      : false;
  const autoExecuteWorkerFileActions = workerFileAutoExecutionConfigured
    ? ap.autoExecuteWorkerFileActions === true
    : DEFAULT_HARNESS_SETTINGS.approval.autoExecuteWorkerFileActions;
  return {
    ok: true,
    value: {
      agent: {
        provider: a.provider,
        model: a.model,
        timeoutMs: a.timeoutMs,
        stallTimeoutMs: a.stallTimeoutMs,
        contextDepth: a.contextDepth,
        codexWorkspaceWrite,
        codexAutoReview,
      },
      orchestration: {
        enabled: orchestrationEnabled,
        defaultMode: orchestrationMode,
        defaultInstructions: orchestrationInstructions,
        workerProfiles,
        defaultPipelineId,
      },
      approval: {
        autoApprove,
        autoExecuteWorkerFileActions,
        workerFileAutoExecutionConfigured,
      },
    },
  };
};

export const registerSettingsIpc = (
  state: LocalStateService,
  onUpdate?: (s: HarnessSettings) => void,
): void => {
  ipcMain.handle(
    IPC_CHANNELS.settings.get,
    async (): Promise<HarnessResult<HarnessSettings>> => {
      try {
        return ok(await state.getSettings());
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return err(harnessError(STATE_INVALID_INPUT, msg));
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.settings.update,
    async (_e, input: unknown): Promise<HarnessResult<HarnessSettings>> => {
      const v = validateSettingsInput(input);
      if (!v.ok) {
        return err(harnessError(STATE_INVALID_INPUT, v.reason));
      }
      try {
        const saved = await state.updateSettings(v.value);
        try { onUpdate?.(saved); } catch { /* non-fatal */ }
        return ok(saved);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return err(harnessError(STATE_INVALID_INPUT, msg));
      }
    },
  );
};
