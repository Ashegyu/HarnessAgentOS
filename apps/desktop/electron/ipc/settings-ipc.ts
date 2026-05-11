import { ipcMain } from "electron";
import {
  IPC_CHANNELS,
  STATE_INVALID_INPUT,
  err,
  harnessError,
  ok,
  type AgentProvider,
  type HarnessResult,
  type HarnessSettings,
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
  return {
    ok: true,
    value: {
      agent: {
        provider: a.provider,
        model: a.model,
        timeoutMs: a.timeoutMs,
        stallTimeoutMs: a.stallTimeoutMs,
        contextDepth: a.contextDepth,
      },
    },
  };
};

export const registerSettingsIpc = (state: LocalStateService): void => {
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
        return ok(await state.updateSettings(v.value));
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return err(harnessError(STATE_INVALID_INPUT, msg));
      }
    },
  );
};
