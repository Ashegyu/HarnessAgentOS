import { randomUUID } from "node:crypto";

/**
 * Domain ids are namespaced UUIDs so that they self-identify in logs
 * and traces. The rest of the id is a v4 UUID.
 */
const PREFIXES = {
  thread: "thr_",
  taskRun: "tsk_",
  step: "stp_",
  checkpoint: "ckp_",
  approval: "apv_",
  artifact: "art_",
  qualityGate: "qg_",
  capability: "cap_",
  learningTrace: "lrn_",
  observation: "obs_",
  instinct: "ins_",
  evolutionCandidate: "evo_",
  agentInvocation: "inv_",
  agentProfile: "ap_",
  mcpServer: "mcp_",
  skillSource: "ss_",
  agentPipeline: "pipe_",
  a2aEndpoint: "a2a_",
  a2aRefinement: "a2aref_",
  repairAttempt: "rpa_",
  evalRun: "evrun_",
} as const;

export type IdKind = keyof typeof PREFIXES;

export const newId = (kind: IdKind): string => `${PREFIXES[kind]}${randomUUID()}`;

export const nowIso = (): string => new Date().toISOString();
