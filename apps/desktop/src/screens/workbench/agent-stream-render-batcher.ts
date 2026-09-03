export interface AgentStreamFrameScheduler {
  schedule(callback: () => void): number;
  cancel(handle: number): void;
}

export interface AgentStreamRenderBatcher {
  request(): void;
  flushNow(): void;
  cancel(): void;
}

export const createAgentStreamRenderBatcher = (
  render: () => void,
  scheduler: AgentStreamFrameScheduler = browserFrameScheduler,
): AgentStreamRenderBatcher => {
  let pendingHandle: number | null = null;

  const cancelPending = (): void => {
    if (pendingHandle === null) return;
    scheduler.cancel(pendingHandle);
    pendingHandle = null;
  };

  return {
    request(): void {
      if (pendingHandle !== null) return;
      pendingHandle = scheduler.schedule(() => {
        pendingHandle = null;
        render();
      });
    },
    flushNow(): void {
      cancelPending();
      render();
    },
    cancel: cancelPending,
  };
};

const browserFrameScheduler: AgentStreamFrameScheduler = {
  schedule(callback): number {
    return window.requestAnimationFrame(() => callback());
  },
  cancel(handle): void {
    window.cancelAnimationFrame(handle);
  },
};
