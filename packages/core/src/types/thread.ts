export interface Thread {
  id: string;
  title: string;
  targetDir?: string;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
  /**
   * Claude CLI session UUID used to chain agent invocations within this
   * thread. Set by the agent planner on the first invocation; subsequent
   * runs `--resume` it so follow-up questions share conversation memory.
   * `undefined` until the first claude agent invocation completes.
   */
  agentSessionId?: string;
  /**
   * AgentPipeline.id bound at thread creation. When set, every TaskRun
   * created in this thread routes through `orchestration.draftPlan` with
   * this pipeline instead of the regular single-profile chat path.
   * Empty/undefined means "regular chat" (uses activeAgentProfileId).
   *
   * No FK constraint — if the referenced pipeline is later deleted the
   * UI shows "(없음)" and routing transparently falls back to regular
   * chat. See docs/design/pipeline-thread-binding-plan.html §4.2.
   */
  pipelineId?: string;
}

export interface CreateThreadInput {
  title: string;
  targetDir?: string;
  pipelineId?: string;
}

export interface UpdateThreadInput {
  title?: string;
  targetDir?: string;
  archivedAt?: string | null;
  agentSessionId?: string | null;
  /** Pass null to clear the existing pipeline binding. */
  pipelineId?: string | null;
}
