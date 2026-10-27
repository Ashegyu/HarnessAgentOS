import type { App } from "electron";

/** A failed/timed-out drain never closes a DB still owned by running work. */
export const installApplicationShutdown = (input: {
  app: Pick<App, "on" | "quit">;
  drain: () => Promise<void>;
  close: () => void;
  onError: (error: unknown) => void;
  timeoutMs?: number;
}): void => {
  let phase: "open" | "draining" | "ready" = "open";
  input.app.on("before-quit", event => {
    if (phase === "ready") return;
    event.preventDefault();
    if (phase === "draining") return;
    phase = "draining";
    let timer: ReturnType<typeof setTimeout> | undefined;
    void (async () => {
      try {
        // Invoke synchronously so admission closes before another quit/request.
        const drain = input.drain();
        await Promise.race([drain, new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error("Application shutdown timed out; storage remains open")), input.timeoutMs ?? 20_000);
        })]);
        input.close();
        phase = "ready";
        input.app.quit();
      } catch (error) {
        phase = "open";
        input.onError(error);
      } finally { if (timer) clearTimeout(timer); }
    })();
  });
};
