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
    listArtifacts: "runner:listArtifacts",
    readArtifact: "runner:readArtifact",
    retryApproval: "runner:retryApproval",
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
    readSkill: "capability:readSkill",
    proposeScriptRun: "capability:proposeScriptRun",
  },
  learner: {
    getTrace: "learner:getTrace",
    recommend: "learner:recommend",
    recordSelection: "learner:recordSelection",
    recordOutcome: "learner:recordOutcome",
    recordDecision: "learner:recordDecision",
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
