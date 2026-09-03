import { harnessError, AGENT_CANCELLED } from "@harness/core";
import type { AgentProvider } from "@harness/core";

/**
 * Phase 8 — Codex FIFO queue with a single default in-flight slot.
 *
 * Policy (matches phase-08 §"Concurrency"):
 *   - Codex uses one default lane. Pipeline workers may opt into independent
 *     lanes while the UI still reports the aggregate Codex depth.
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
  provider: AgentProvider;
  inflight: QueueEntry | null;
  waiting: QueueEntry[];
}

export class AgentInvocationQueue {
  private readonly lanes = new Map<string, ProviderLane>(
    providers.map((provider) => [
      provider,
      { provider, inflight: null, waiting: [] },
    ]),
  );

  /**
   * Submit `work` for `provider`. Resolves with the work's value or
   * rejects with the work's error. If `cancel(invocationId)` is called
   * before work starts, the returned promise rejects via the work
   * itself (work observes `signal.aborted` synchronously on entry).
   */
  enqueue<T>(input: {
    provider: AgentProvider;
    invocationId: string;
    /**
     * Optional independent concurrency lane. Omit for the default
     * provider FIFO behavior used by standalone agent.generatePlan.
     * Pipeline worker calls use unique lanes so same-provider read-only
     * workers can actually run in parallel.
     */
    laneKey?: string;
    work: AgentInvocationWork<T>;
  }): Promise<T> {
    const { provider, invocationId, work } = input;
    const laneKey = normalizeLaneKey(provider, input.laneKey);
    const lane = this.getOrCreateLane(provider, laneKey);
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
                this.drain(laneKey);
              },
              (err) => {
                lane.inflight = null;
                reject(err);
                this.drain(laneKey);
              },
            );
        },
      };
      lane.waiting.push(entry);
      if (lane.inflight === null) this.drain(laneKey);
    });
  }

  /**
   * Cancel a queued or in-flight invocation. Returns true if a matching
   * entry was found. For in-flight items the AbortController is fired;
   * the actual rejection arrives through the original `enqueue` promise.
   */
  cancel(invocationId: string): boolean {
    for (const [laneKey, lane] of this.lanes) {
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
        this.pruneLane(laneKey);
        return true;
      }
    }
    return false;
  }

  /** Depth = waiting + (1 if in-flight). Read by RuntimeStatusBar. */
  getDepth(provider: AgentProvider): number {
    let depth = 0;
    for (const lane of this.lanes.values()) {
      if (lane.provider !== provider) continue;
      depth += lane.waiting.length + (lane.inflight !== null ? 1 : 0);
    }
    return depth;
  }

  /** True when the given invocationId is queued or currently running. */
  isBusy(invocationId: string): boolean {
    for (const lane of this.lanes.values()) {
      if (lane.inflight?.invocationId === invocationId) return true;
      if (lane.waiting.some((e) => e.invocationId === invocationId)) return true;
    }
    return false;
  }

  private drain(laneKey: string): void {
    const lane = this.lanes.get(laneKey);
    if (!lane) return;
    if (lane.inflight !== null) return;
    const next = lane.waiting.shift();
    if (!next) {
      this.pruneLane(laneKey);
      return;
    }
    next.run();
  }

  private getOrCreateLane(
    provider: AgentProvider,
    laneKey: string,
  ): ProviderLane {
    const existing = this.lanes.get(laneKey);
    if (existing) return existing;
    const lane: ProviderLane = { provider, inflight: null, waiting: [] };
    this.lanes.set(laneKey, lane);
    return lane;
  }

  private pruneLane(laneKey: string): void {
    if (defaultLaneKeys.has(laneKey)) return;
    const lane = this.lanes.get(laneKey);
    if (!lane || lane.inflight !== null || lane.waiting.length > 0) return;
    this.lanes.delete(laneKey);
  }
}

const providers: readonly AgentProvider[] = ["codex"];
const defaultLaneKeys = new Set<string>(providers);

const normalizeLaneKey = (
  provider: AgentProvider,
  laneKey: string | undefined,
): string => (laneKey ? `${provider}:${laneKey}` : provider);
