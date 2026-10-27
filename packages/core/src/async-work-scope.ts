/** Owns asynchronous work from entry through its final cleanup. No I/O. */
export class AsyncWorkScope {
  private readonly pending = new Set<Promise<unknown>>();
  private sealed = false;

  constructor(private readonly closedError: () => Error = () => new Error("APPLICATION_SHUTTING_DOWN")) {}

  get closed(): boolean { return this.sealed; }

  run<T>(work: () => T | Promise<T>): Promise<T> {
    if (this.sealed) return Promise.reject(this.closedError());
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (error: unknown) => void;
    const pending = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    this.pending.add(pending);
    const remove = () => { this.pending.delete(pending); };
    void pending.then(remove, remove);
    try { resolve(work()); } catch (error) { reject(error); }
    return pending;
  }

  seal(): void { this.sealed = true; }

  async drain(): Promise<void> {
    while (this.pending.size > 0) await Promise.allSettled([...this.pending]);
  }
}
