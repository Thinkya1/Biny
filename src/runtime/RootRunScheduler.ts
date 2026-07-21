/**
 * Serializes root agent turns for one interactive runtime.
 *
 * The scheduler owns admission, cancellation and promise settlement. The
 * runtime owns the actual agent execution and presentation events. Keeping
 * those responsibilities separate makes a setup failure or a cancelled queued
 * turn unable to strand a caller on an unresolved completion promise.
 */
export interface RootRunIdentity {
  runId: string;
}

export interface RootRunSchedulerOptions<TRun extends RootRunIdentity, TResult> {
  maxQueuedRuns: number;
  execute(run: TRun, signal: AbortSignal): Promise<TResult>;
  onQueuedCancellation(run: TRun, reason: string): TResult;
  onExecutionFailure(run: TRun, error: unknown): TResult;
}

export interface SubmittedRootRun<TResult> {
  queued: boolean;
  completion: Promise<TResult>;
}

interface QueuedRootRun<TRun extends RootRunIdentity, TResult> {
  run: TRun;
  resolve(result: TResult): void;
  reject(error: unknown): void;
}

interface ActiveRootRun<TRun extends RootRunIdentity> {
  run: TRun;
  controller: AbortController;
}

export class RootRunQueueFullError extends Error {
  constructor(readonly maxQueuedRuns: number) {
    super(`Agent run queue is full (max ${String(maxQueuedRuns)} queued runs).`);
    this.name = "RootRunQueueFullError";
  }
}

export class RootRunScheduler<TRun extends RootRunIdentity, TResult> {
  private readonly queue: Array<QueuedRootRun<TRun, TResult>> = [];
  private active: ActiveRootRun<TRun> | undefined;
  private drainPromise: Promise<void> | undefined;
  private closed = false;

  constructor(private readonly options: RootRunSchedulerOptions<TRun, TResult>) {
    if (!Number.isSafeInteger(options.maxQueuedRuns) || options.maxQueuedRuns < 1) {
      throw new Error("maxQueuedRuns must be a positive safe integer.");
    }
  }

  get activeRun(): TRun | undefined {
    return this.active?.run;
  }

  get queuedRuns(): readonly TRun[] {
    return this.queue.map(({ run }) => run);
  }

  get queueLength(): number {
    return this.queue.length;
  }

  submit(run: TRun): SubmittedRootRun<TResult> {
    if (this.closed) throw new Error("Agent run scheduler is closed.");
    if (this.queue.length >= this.options.maxQueuedRuns) {
      throw new RootRunQueueFullError(this.options.maxQueuedRuns);
    }
    const queued = this.active !== undefined || this.queue.length > 0;
    let resolveCompletion!: (result: TResult) => void;
    let rejectCompletion!: (error: unknown) => void;
    const completion = new Promise<TResult>((resolve, reject) => {
      resolveCompletion = resolve;
      rejectCompletion = reject;
    });
    this.queue.push({ run, resolve: resolveCompletion, reject: rejectCompletion });
    this.drainPromise ??= this.drain();
    return { queued, completion };
  }

  cancel(runId: string, reason = "Current turn interrupted."): boolean {
    if (this.active?.run.runId === runId) {
      this.active.controller.abort(new Error(reason));
      return true;
    }
    const queuedIndex = this.queue.findIndex(({ run }) => run.runId === runId);
    if (queuedIndex < 0) return false;
    const [queued] = this.queue.splice(queuedIndex, 1);
    if (!queued) return false;
    this.settleQueuedCancellation(queued, reason);
    return true;
  }

  cancelAll(reason = "Current turn interrupted."): void {
    if (this.active) this.active.controller.abort(new Error(reason));
    for (const queued of this.queue.splice(0)) {
      this.settleQueuedCancellation(queued, reason);
    }
  }

  async waitForIdle(): Promise<void> {
    while (this.active || this.queue.length || this.drainPromise) {
      const drain = this.drainPromise;
      if (drain) await drain;
      else await new Promise<void>((resolve) => queueMicrotask(resolve));
    }
  }

  close(reason = "Agent runtime is closing."): void {
    if (this.closed) return;
    this.closed = true;
    this.cancelAll(reason);
  }

  private async drain(): Promise<void> {
    try {
      while (!this.closed && this.queue.length) {
        const queued = this.queue.shift();
        if (!queued) continue;
        const active: ActiveRootRun<TRun> = { run: queued.run, controller: new AbortController() };
        this.active = active;
        let result: TResult;
        try {
          result = await this.options.execute(active.run, active.controller.signal);
        } catch (error) {
          try {
            result = this.options.onExecutionFailure(active.run, error);
          } catch (failure) {
            queued.reject(failure);
            continue;
          }
        } finally {
          if (this.active === active) this.active = undefined;
        }
        queued.resolve(result);
      }
    } finally {
      this.drainPromise = undefined;
      if (!this.closed && this.queue.length) this.drainPromise = this.drain();
    }
  }

  private settleQueuedCancellation(queued: QueuedRootRun<TRun, TResult>, reason: string): void {
    try {
      queued.resolve(this.options.onQueuedCancellation(queued.run, reason));
    } catch (error) {
      queued.reject(error);
    }
  }
}
