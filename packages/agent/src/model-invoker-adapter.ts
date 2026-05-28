import type { ModelCliAdapter } from "./model-cli-types.ts";
import type {
  ModelInvoker,
  ModelInvokeRequest,
  ModelInvokeResult,
} from "./model-invoker-types.ts";

export const modelInvokerFromCliAdapter = (
  adapter: ModelCliAdapter,
): ModelInvoker => ({
  invoke(
    request: ModelInvokeRequest,
    onEvent,
    signal?: AbortSignal,
  ): Promise<ModelInvokeResult> {
    return adapter.invoke(request, onEvent, signal);
  },
});
