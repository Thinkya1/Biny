/**
 * Small async FIFO used at runtime boundaries where producers and consumers
 * do not share a call stack. It deliberately has one consumer: an async
 * iterator is a stream, not a broadcast channel.
 */
export class AsyncEventQueue<T> implements AsyncIterable<T> {
  private readonly values: T[] = [];
  private readonly waiters: Array<{
    resolve(result: IteratorResult<T>): void;
    reject(error: Error): void;
  }> = [];
  private readonly progressWaiters: Array<() => void> = [];
  private closed = false;
  private failure: Error | undefined;

  /** Number of values accepted by producers. */
  pushedCount = 0;
  /** Number of yielded values acknowledged by the consumer. */
  consumedCount = 0;
  /** The consumer stopped pulling before the producer completed. */
  consumerDetached = false;

  push(value: T): void {
    if (this.closed || this.failure) return;
    this.pushedCount += 1;
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve({ value, done: false });
    else this.values.push(value);
    this.wakeProgressWaiters();
  }

  /**
   * The consumer calls this only after it has finished handling an item.
   * Producers can use the counters with waitForProgress() without polling.
   */
  ackConsumed(): void {
    this.consumedCount += 1;
    this.wakeProgressWaiters();
  }

  waitForProgress(): Promise<void> {
    return new Promise<void>((resolve) => this.progressWaiters.push(resolve));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    while (this.waiters.length) {
      this.waiters.shift()?.resolve({ value: undefined as unknown as T, done: true });
    }
    this.wakeProgressWaiters();
  }

  error(error: Error | unknown): void {
    if (this.closed || this.failure) return;
    this.failure = error instanceof Error ? error : new Error(String(error));
    this.closed = true;
    this.values.length = 0;
    while (this.waiters.length) this.waiters.shift()?.reject(this.failure);
    this.wakeProgressWaiters();
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: async (): Promise<IteratorResult<T>> => {
        if (this.failure) throw this.failure;
        if (this.values.length) return { value: this.values.shift() as T, done: false };
        if (this.closed) return { value: undefined as unknown as T, done: true };
        return await new Promise<IteratorResult<T>>((resolve, reject) => this.waiters.push({ resolve, reject }));
      },
      return: async (): Promise<IteratorResult<T>> => {
        this.consumerDetached = true;
        this.values.length = 0;
        this.close();
        return { value: undefined as unknown as T, done: true };
      }
    };
  }

  private wakeProgressWaiters(): void {
    if (!this.progressWaiters.length) return;
    const waiters = this.progressWaiters.splice(0);
    for (const resolve of waiters) resolve();
  }
}
