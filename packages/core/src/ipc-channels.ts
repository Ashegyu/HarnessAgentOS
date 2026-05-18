/**
 * Single source of truth for IPC channel strings.
 * Channel format: `{namespace}:{verb}` - dot notation in docs maps to colon
 * here (Electron channels conventionally use colons).
 *
 * Phase-by-phase the namespaces grow per docs/contracts/ipc-contracts.md.
 */
export const IPC_CHANNELS = {
  app: {
    getVersion: "app:getVersion",
    getRuntimeInfo: "app:getRuntimeInfo",
    selectDirectory: "app:selectDirectory",
    selectFile: "app:selectFile",
  },
  state: {
    listThreads: "state:listThreads",
    getThread: "state:getThread",
    createThread: "state:createThread",
    deleteThread: "state:deleteThread",
  },
  conversation: {
    createTask: "conversation:createTask",
    redirectTask: "conversation:redirectTask",
    approve: "conversation:approve",
    rejectApproval: "conversation:rejectApproval",
    getTaskRunDetail: "conversation:getTaskRunDetail",
    setProposedAction: "conversation:setProposedAction",
    pauseTask: "conversation:pauseTask",
    resumeTask: "conversation:resumeTask",
    cancelTask: "conversation:cancelTask",
    deleteTask: "conversation:deleteTask",
  },
  runner: {
    executeApproved: "runner:executeApproved",
    cancelExecution: "runner:cancelExecution",
    listArtifacts: "runner:listArtifacts",
    readArtifact: "runner:readArtifact",
    retryApproval: "runner:retryApproval",
  },
  shadow: {
    createPreview: "shadow:createPreview",
  },
  quality: {
    evaluate: "quality:evaluate",
    getLatest: "quality:getLatest",
    approveKnownRisks: "quality:approveKnownRisks",
    createRepairPlan: "quality:createRepairPlan",
    markReadyForReview: "quality:markReadyForReview",
    markDone: "quality:markDone",
  },
  capability: {
    list: "capability:list",
    refresh: "capability:refresh",
    suggest: "capability:suggest",
    proposeCandidates: "capability:proposeCandidates",
    readSkill: "capability:readSkill",
    proposeScriptRun: "capability:proposeScriptRun",
  },
  learner: {
    getTrace: "learner:getTrace",
    recommend: "learner:recommend",
    proposeRecommendation: "learner:proposeRecommendation",
    recordSelection: "learner:recordSelection",
    recordOutcome: "learner:recordOutcome",
    recordDecision: "learner:recordDecision",
  },
  topology: {
    recommend: "topology:recommend",
    recordFeedback: "topology:recordFeedback",
  },
  instinct: {
    list: "instinct:list",
    listCandidates: "instinct:listCandidates",
    approveCandidate: "instinct:approveCandidate",
    rejectCandidate: "instinct:rejectCandidate",
    disable: "instinct:disable",
  },
  orchestration: {
    draftPlan: "orchestration:draftPlan",
    runApproved: "orchestration:runApproved",
    getPlan: "orchestration:getPlan",
  },
  agent: {
    checkProviders: "agent:checkProviders",
    generatePlan: "agent:generatePlan",
    cancelInvocation: "agent:cancelInvocation",
    retryInvocation: "agent:retryInvocation",
    useTemplateFallback: "agent:useTemplateFallback",
  },
  settings: {
    get: "settings:get",
    update: "settings:update",
  },
  /** Agent profile CRUD — see docs/design/agent-detailed-settings.md §5 Phase 3. */
  agents: {
    list: "agents:list",
    get: "agents:get",
    create: "agents:create",
    update: "agents:update",
    delete: "agents:delete",
    setDefault: "agents:setDefault",
    setActive: "agents:setActive",
  },
  /** MCP server registry — upsert merges create+update. */
  mcp: {
    list: "mcp:list",
    upsert: "mcp:upsert",
    delete: "mcp:delete",
    toggle: "mcp:toggle",
    healthCheck: "mcp:healthCheck",
  },
  /** Skill source registry (trusted directories for SKILL.md). */
  skillSource: {
    list: "skillSource:list",
    add: "skillSource:add",
    update: "skillSource:update",
    remove: "skillSource:remove",
    refresh: "skillSource:refresh",
    previewSkillDraft: "skillSource:previewSkillDraft",
    proposeSkillFile: "skillSource:proposeSkillFile",
  },
  /**
   * SecretVault management. Write/clear/listKeys only — there is no read
   * channel. Plaintext decryption happens in the main process at spawn
   * time and is never returned to the renderer.
   */
  secret: {
    write: "secret:write",
    clear: "secret:clear",
    listKeys: "secret:listKeys",
  },
  /**
   * AgentPipeline templates — linear sequence of AgentProfile references
   * used by OrchestrationPlanner when supplied with `pipelineId`. CRUD only;
   * execution is owned by orchestration.
   */
  pipeline: {
    list: "pipeline:list",
    get: "pipeline:get",
    create: "pipeline:create",
    update: "pipeline:update",
    delete: "pipeline:delete",
  },
  /** Remote A2A agent registry. SDK and network execution stay in main. */
  remoteAgents: {
    list: "remoteAgents:list",
    get: "remoteAgents:get",
    upsertEndpoint: "remoteAgents:upsertEndpoint",
    delete: "remoteAgents:delete",
    toggle: "remoteAgents:toggle",
    upsertCardSnapshot: "remoteAgents:upsertCardSnapshot",
  },
  /** Phase 16 eval result viewer. Read-only renderer surface. */
  evals: {
    listRuns: "evals:listRuns",
    getRun: "evals:getRun",
    getCostTrend: "evals:getCostTrend",
    getRuntimeLatencySummary: "evals:getRuntimeLatencySummary",
  },
  events: {
    /**
     * One-way main → renderer push (id-only). Emitted whenever a TaskRun
     * row changes in the canonical store so the workbench can refresh
     * without the renderer having to poll.
     */
    taskRunChanged: "events:taskRunChanged",
    /**
     * One-way main → renderer push (scoped chunk). Emitted while an
     * `agent.generatePlan` invocation streams output. Each chunk carries
     * `invocationId`; renderer filters to its own invocation. Payload
     * passes through secret-redaction before broadcast.
     */
    agentStreamEvent: "events:agentStreamEvent",
  },
} as const;

export type IpcChannelMap = typeof IPC_CHANNELS;

/**
 * Flat allowlist of channel strings. Both preload and main use this
 * to refuse any channel not declared here.
 */
export const ALLOWED_IPC_CHANNELS: readonly string[] = Object.values(
  IPC_CHANNELS,
).flatMap((ns) => Object.values(ns));

export const isAllowedChannel = (channel: string): boolean =>
  ALLOWED_IPC_CHANNELS.includes(channel);
