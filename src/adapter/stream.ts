/**
 * A queue that presents itself as an async iterable.
 *
 * The SDK's control methods (setModel, setPermissionMode, interrupt) only work
 * in streaming input mode, which means the prompt has to be an async iterable
 * that stays open for the life of the session rather than a string. Keyboard
 * input arrives whenever the user types, so something has to bridge a push
 * shaped source to a pull shaped consumer. This is that bridge.
 */
export class PushStream<T> implements AsyncIterable<T> {
  private readonly queued: T[] = [];
  private readonly waiting: Array<(result: IteratorResult<T>) => void> = [];
  private closed = false;

  push(value: T): void {
    if (this.closed) return;
    const waiter = this.waiting.shift();
    if (waiter) {
      waiter({ value, done: false });
      return;
    }
    this.queued.push(value);
  }

  /** Close the stream. Consumers drain whatever is queued, then finish. */
  end(): void {
    if (this.closed) return;
    this.closed = true;
    while (this.waiting.length > 0) {
      this.waiting.shift()?.({ value: undefined, done: true });
    }
  }

  get isClosed(): boolean {
    return this.closed;
  }

  get pending(): number {
    return this.queued.length;
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        if (this.queued.length > 0) {
          const value = this.queued.shift() as T;
          return Promise.resolve({ value, done: false });
        }
        if (this.closed) {
          return Promise.resolve({ value: undefined, done: true });
        }
        return new Promise((resolve) => {
          this.waiting.push(resolve);
        });
      },
      return: (): Promise<IteratorResult<T>> => {
        this.end();
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }
}
