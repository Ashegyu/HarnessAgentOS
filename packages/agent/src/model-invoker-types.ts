import type { AgentStreamEvent } from "@harness/core";
import type { ModelCliRequest, ModelCliResult } from "./model-cli-types.ts";

export type ModelInvokeRequest = ModelCliRequest;

export type ModelInvokeResult = ModelCliResult;

export interface ModelInvoker {
  invoke(
    request: ModelInvokeRequest,
    onEvent: (e: AgentStreamEvent) => void,
    signal?: AbortSignal,
  ): Promise<ModelInvokeResult>;
}
