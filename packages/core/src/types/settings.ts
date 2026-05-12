import type { OrchestrationMode, WorkerRole } from "./orchestration.ts";

export type AgentProvider = "auto" | "claude" | "codex";

export interface AgentSettings {
  provider: AgentProvider;
  model: string;
  timeoutMs: number;
  stallTimeoutMs: number;
  contextDepth: number;
}

export interface WorkerProfile {
  id: string;
  name: string;
  provider: AgentProvider;
  model: string;
  role: WorkerRole;
}

export interface OrchestrationSettings {
  enabled: boolean;
  defaultMode: OrchestrationMode;
  defaultInstructions: string;
  workerProfiles: WorkerProfile[];
}

/**
 * Approval automation. When `autoApprove` is true, the renderer
 * auto-approves and executes every pending approval — including
 * high-risk action types (dependency_install, git_commit, skill_script,
 * network) and orchestration_plan. The service-layer security model is
 * unchanged: this is a UI-level convenience that bypasses the human-in-
 * the-loop step, so the user has explicitly opted out of confirmation.
 */
export interface ApprovalSettings {
  autoApprove: boolean;
}

export interface HarnessSettings {
  agent: AgentSettings;
  orchestration: OrchestrationSettings;
  approval: ApprovalSettings;
}

export const DEFAULT_HARNESS_SETTINGS: Readonly<HarnessSettings> =
  Object.freeze({
    agent: Object.freeze({
      provider: "auto" as AgentProvider,
      model: "",
      timeoutMs: 300_000,
      stallTimeoutMs: 60_000,
      contextDepth: 5,
    }),
    orchestration: Object.freeze({
      enabled: false,
      defaultMode: "single_worker" as OrchestrationMode,
      defaultInstructions: "",
      workerProfiles: [] as WorkerProfile[],
    }),
    approval: Object.freeze({
      autoApprove: false,
    }),
  });
