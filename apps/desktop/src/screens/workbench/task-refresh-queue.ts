/** One active pull + one trailing pull per task. Distinct tasks share slots. */
export const createTaskRefreshQueue = <T>(input: {
  load: (id: string) => Promise<T>;
  ready: (id: string, value: T) => void;
  concurrency?: number;
}) => {
  const concurrency = input.concurrency ?? 4;
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 16) throw new Error("Invalid refresh concurrency");
  const requested = new Set<string>();
  const running = new Set<string>();
  let disposed = false;
  const pump = (): void => {
    while (!disposed && running.size < concurrency) {
      let next: string | undefined;
      for (const id of requested) { if (!running.has(id)) { next = id; break; } }
      if (next === undefined) return;
      const id = next;
      requested.delete(id);
      running.add(id);
      void (async () => {
        try {
          const value = await input.load(id);
          if (!disposed) input.ready(id, value);
        } catch { /* Advisory notifications must not stop the queue. */ }
        finally { running.delete(id); pump(); }
      })();
    }
  };
  return {
    request(id: string): void { if (disposed || !id) return; requested.add(id); pump(); },
    dispose(): void { disposed = true; requested.clear(); },
  };
};
