import type { OrchestrationMode, WorkerRole } from "./orchestration.ts";
import {
  DEFAULT_AGENT_STALL_TIMEOUT_MS,
  DEFAULT_AGENT_TIMEOUT_MS,
} from "../execution-timeouts.ts";
import {
  DEFAULT_AGENT_REASONING_EFFORT,
  DEFAULT_CODEX_MODEL,
  type AgentReasoningEffort,
  type CodexModel,
} from "./codex-models.ts";

export type AgentProvider = "codex";

export interface AgentSettings {
  provider: AgentProvider;
  model: CodexModel;
  reasoningEffort: AgentReasoningEffort;
  timeoutMs: number;
  stallTimeoutMs: number;
  contextDepth: number;
  /**
   * When true, Codex CLI invocations use `--sandbox workspace-write`
   * instead of the default `read-only` sandbox.
   */
  codexWorkspaceWrite?: boolean;
  /**
   * When true, Codex CLI invocations enable auto review for provider
   * approval requests.
   */
  codexAutoReview?: boolean;
}

export interface WorkerProfile {
  id: string;
  name: string;
  provider: AgentProvider;
  model: CodexModel;
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
 * auto-approves pending approvals only when their service-layer
 * PolicyEvaluation allows auto approval. capability_use/model_use are
 * auto-approved but not runner-executed; they only gate whether approved
 * Skill context or a Learner model recommendation can enter the next
 * agent prompt/invocation. The service-layer security model is unchanged:
 * blocked or manual-only policy decisions still win over this UI-level
 * convenience.
 */
export interface ApprovalSettings {
  autoApprove: boolean;
  /**
   * Narrow automation for worker-proposed `file_write`/`file_patch` approvals only.
   * This does not approve general file_write/file_patch approvals or any shell /
   * network / git / orchestration actions. The renderer still honors the
   * active AgentProfile block list before approving and executing. This is on
   * by default so worker code changes can apply without a manual click while
   * keeping approval rows as the audit/execution boundary.
   */
  autoExecuteWorkerFileActions: boolean;
  /**
   * False/undefined means an older settings row may still contain the previous
   * default value. Once the user changes the worker-file toggle, the UI sets
   * this to true so an explicit opt-out is preserved.
   */
  workerFileAutoExecutionConfigured?: boolean;
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
      provider: "codex" as AgentProvider,
      model: DEFAULT_CODEX_MODEL,
      reasoningEffort: DEFAULT_AGENT_REASONING_EFFORT,
      timeoutMs: DEFAULT_AGENT_TIMEOUT_MS,
      stallTimeoutMs: DEFAULT_AGENT_STALL_TIMEOUT_MS,
      contextDepth: 5,
      codexWorkspaceWrite: false,
      codexAutoReview: false,
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
      autoExecuteWorkerFileActions: true,
      workerFileAutoExecutionConfigured: false,
    }),
  });
