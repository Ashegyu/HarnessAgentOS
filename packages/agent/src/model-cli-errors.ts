import {
  AGENT_CANCELLED,
  AGENT_INVALID_OUTPUT,
  AGENT_PROVIDER_UNAVAILABLE,
  AGENT_RATE_LIMITED,
  AGENT_SPAWN_FAILED,
  AGENT_STALL,
  AGENT_TIMEOUT,
} from "@harness/core";
import type { AgentErrorKind } from "./model-cli-types.ts";

export class AgentCliError extends Error {
  readonly code: string;
  readonly kind: AgentErrorKind;
  constructor(code: string, kind: AgentErrorKind, message: string) {
    super(message);
    this.name = "AgentCliError";
    this.code = code;
    this.kind = kind;
  }
}

/**
 * Map internal error kinds to the HarnessError.code values declared in
 * docs/contracts/ipc-contracts.md §agent. Keeping the mapping in one
 * place makes it easy to grep when adding kinds later.
 */
export const codeForKind = (kind: AgentErrorKind): string => {
  switch (kind) {
    case "spawn_failed":
      return AGENT_SPAWN_FAILED;
    case "aborted":
      return AGENT_CANCELLED;
    case "stall":
      return AGENT_STALL;
    case "timeout":
      return AGENT_TIMEOUT;
    case "model_invalid":
      return AGENT_INVALID_OUTPUT;
    case "rate_limit":
      return AGENT_RATE_LIMITED;
    case "fatal":
      return AGENT_PROVIDER_UNAVAILABLE;
  }
};
