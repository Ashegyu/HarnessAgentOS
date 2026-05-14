import type { OrchestrationMode, WorkerRole } from "./orchestration.ts";
import {
  DEFAULT_AGENT_STALL_TIMEOUT_MS,
  DEFAULT_AGENT_TIMEOUT_MS,
} from "../execution-timeouts.ts";

export type AgentProvider = "auto" | "claude" | "codex";

export const DEFAULT_CLAUDE_MODEL = "claude-sonnet-4-6";
export const DEFAULT_CODEX_MODEL = "gpt-5.5";

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
  /**
   * AgentPipeline.id pre-selected for new task runs. Empty string means
   * "no default — fall back to the first available pipeline, or legacy
   * mode when none exist". When the referenced pipeline has been deleted,
   * the UI treats this as empty.
   */
  defaultPipelineId: string;
}

/**
 * Approval automation. When `autoApprove` is true, the renderer
 * auto-approves and executes every pending approval — including
 * high-risk action types (dependency_install, git_commit, skill_script,
 * network) and orchestration_plan. capability_use is auto-approved but
 * not runner-executed; it only gates whether approved Skill context can
 * enter the agent prompt. The service-layer security model is unchanged:
 * this is a UI-level convenience that bypasses the human-in-the-loop step,
 * so the user has explicitly opted out of confirmation.
 */
export interface ApprovalSettings {
  autoApprove: boolean;
  /**
   * Narrow automation for worker-proposed `file_write` approvals only.
   * This does not approve general file_write approvals or any shell /
   * network / git / orchestration actions. The renderer still honors the
   * active AgentProfile block list before approving and executing.
   */
  autoExecuteWorkerFileActions: boolean;
}

export interface HarnessSettings {
  agent: AgentSettings;
  orchestration: OrchestrationSettings;
  approval: ApprovalSettings;
  /**
   * AgentProfile.id of the profile currently active for new TaskRuns.
   * When undefined, the resolver falls back to the row with isDefault=true,
   * and ultimately to legacy `agent` when no profile rows exist.
   * See docs/design/agent-detailed-settings.md §4.4.
   */
  activeAgentProfileId?: string;
}

export const DEFAULT_HARNESS_SETTINGS: Readonly<HarnessSettings> =
  Object.freeze({
    agent: Object.freeze({
      provider: "auto" as AgentProvider,
      model: "",
      timeoutMs: DEFAULT_AGENT_TIMEOUT_MS,
      stallTimeoutMs: DEFAULT_AGENT_STALL_TIMEOUT_MS,
      contextDepth: 5,
    }),
    orchestration: Object.freeze({
      enabled: false,
      defaultMode: "single_worker" as OrchestrationMode,
      defaultInstructions: "",
      workerProfiles: [] as WorkerProfile[],
      defaultPipelineId: "",
    }),
    approval: Object.freeze({
      autoApprove: false,
      autoExecuteWorkerFileActions: false,
    }),
  });
