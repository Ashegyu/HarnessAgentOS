import { harnessError, AGENT_CANCELLED } from "@harness/core";
import type { AgentProvider } from "@harness/core";

/**
 * Phase 8 — per-provider FIFO queue with single in-flight slot.
 *
 * Policy (matches phase-08 §"Concurrency"):
 *   - claude and codex have INDEPENDENT 1-slot semaphores. claude work
 *     never blocks codex work. This means "starvation between providers"
 *     is impossible by construction; starvation WITHIN a provider is the
 *     caller's responsibility (e.g. UI shows queue depth so the user can
 *     cancel head-of-line blockers).
 *   - `enqueue` is the only public way work runs. It resolves with the
 *     work's return value or rejects with whatever the work threw.
 *   - `cancel(invocationId)` removes a queued entry without invoking the
 *     work AND aborts the AbortController for an in-flight entry. The
 *     work function MUST observe `signal.aborted` and surface the
 *     cancellation through its own rejection.
 *   - `getDepth(provider)` is the live count of waiting + in-flight
 *     entries. RuntimeStatusBar reads this through `checkProviders()`.
 *
 * Implementation note: this is a small hand-rolled queue rather than a
 * dependency on `p-queue` per the phase-08 "no new npm deps" rule.
 */
export type AgentInvocationWork<T> = (signal: AbortSignal) => Promise<T>;

interface QueueEntry {
  invocationId: string;
  controller: AbortController;
  run: () => void;
  reject: (err: unknown) => void;
}

interface ProviderLane {
  inflight: QueueEntry | null;
  waiting: QueueEntry[];
}

export class AgentInvocationQueue {
  private readonly lanes: Record<AgentProvider, ProviderLane> = {
    claude: { inflight: null, waiting: [] },
    codex: { inflight: null, waiting: [] },
  };

  /**
   * Submit `work` for `provider`. Resolves with the work's value or
   * rejects with the work's error. If `cancel(invocationId)` is called
   * before work starts, the returned promise rejects via the work
   * itself (work observes `signal.aborted` synchronously on entry).
   */
  enqueue<T>(input: {
    provider: AgentProvider;
    invocationId: string;
    work: AgentInvocationWork<T>;
  }): Promise<T> {
    const { provider, invocationId, work } = input;
    const lane = this.lanes[provider];
    const controller = new AbortController();
    return new Promise<T>((resolve, reject) => {
      const entry: QueueEntry = {
        invocationId,
        controller,
        reject,
        run: () => {
          lane.inflight = entry;
          Promise.resolve()
            .then(() => work(controller.signal))
            .then(
              (value) => {
                lane.inflight = null;
                resolve(value);
                this.drain(provider);
              },
              (err) => {
                lane.inflight = null;
                reject(err);
                this.drain(provider);
              },
            );
        },
      };
      lane.waiting.push(entry);
      if (lane.inflight === null) this.drain(provider);
    });
  }

  /**
   * Cancel a queued or in-flight invocation. Returns true if a matching
   * entry was found. For in-flight items the AbortController is fired;
   * the actual rejection arrives through the original `enqueue` promise.
   */
  cancel(invocationId: string): boolean {
    for (const provider of providers) {
      const lane = this.lanes[provider];
      if (lane.inflight && lane.inflight.invocationId === invocationId) {
        lane.inflight.controller.abort();
        return true;
      }
      const idx = lane.waiting.findIndex(
        (e) => e.invocationId === invocationId,
      );
      if (idx >= 0) {
        const entry = lane.waiting[idx]!;
        lane.waiting.splice(idx, 1);
        entry.reject(harnessError(AGENT_CANCELLED, "invocation cancelled before start"));
        return true;
      }
    }
    return false;
  }

  /** Depth = waiting + (1 if in-flight). Read by RuntimeStatusBar. */
  getDepth(provider: AgentProvider): number {
    const lane = this.lanes[provider];
    return lane.waiting.length + (lane.inflight !== null ? 1 : 0);
  }

  /** True when the given invocationId is queued or currently running. */
  isBusy(invocationId: string): boolean {
    for (const provider of providers) {
      const lane = this.lanes[provider];
      if (lane.inflight?.invocationId === invocationId) return true;
      if (lane.waiting.some((e) => e.invocationId === invocationId)) return true;
    }
    return false;
  }

  private drain(provider: AgentProvider): void {
    const lane = this.lanes[provider];
    if (lane.inflight !== null) return;
    const next = lane.waiting.shift();
    if (!next) return;
    next.run();
  }
}

const providers: readonly AgentProvider[] = ["claude", "codex"];
