/**
 * A tiny push/pull event stream, shared by the telephony and streaming-speech
 * ports (phase 5.1/5.2).
 *
 * Both ports have the same awkward shape: a provider pushes events whenever it
 * likes, and the runtime wants to `await` the next one with a timeout. Node has
 * no primitive for that — `EventEmitter` is push-only and an async generator is
 * pull-only — so this is the adapter between them, written once rather than
 * three times.
 *
 * The buffering behaviour is the part that matters. Events that arrive with no
 * waiter are *queued*, not dropped: a DTMF digit pressed while the runtime was
 * mid-synthesis must still be the next thing it sees, because losing it is
 * losing the caller's approval.
 */

export interface StreamSubscription {
  unsubscribe(): void;
}

export class EventStream<T> {
  private readonly buffer: T[] = [];
  private readonly waiters: Array<(value: IteratorResult<T>) => void> = [];
  private readonly listeners = new Set<(value: T) => void>();
  private closed = false;

  get pending(): number {
    return this.buffer.length;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  push(value: T): void {
    if (this.closed) return;

    for (const listener of [...this.listeners]) {
      try {
        listener(value);
      } catch {
        // A misbehaving observer must not stop the call. The event still
        // reaches every other subscriber and the queue.
      }
    }

    const waiter = this.waiters.shift();
    if (waiter !== undefined) {
      waiter({ value, done: false });
      return;
    }

    this.buffer.push(value);
  }

  /** Fires for every event from now on. Never receives what is already queued. */
  subscribe(listener: (value: T) => void): StreamSubscription {
    this.listeners.add(listener);
    return {
      unsubscribe: () => {
        this.listeners.delete(listener);
      },
    };
  }

  /**
   * The next event, or null when the stream closes or the wait times out.
   *
   * A timeout returning null rather than throwing is deliberate: on a phone
   * call, "nothing happened for 700 ms" is the most important event there is —
   * it is how a turn ends — and making the caller catch an exception to learn
   * it would invert the shape of the loop.
   */
  async next(timeoutMs?: number): Promise<T | null> {
    const queued = this.buffer.shift();
    if (queued !== undefined) return queued;
    if (this.closed) return null;

    return new Promise<T | null>((resolve) => {
      let settled = false;
      const timer =
        timeoutMs === undefined
          ? null
          : setTimeout(() => {
              if (settled) return;
              settled = true;
              const index = this.waiters.indexOf(waiter);
              if (index >= 0) this.waiters.splice(index, 1);
              resolve(null);
            }, timeoutMs);

      const waiter = (result: IteratorResult<T>): void => {
        if (settled) return;
        settled = true;
        if (timer !== null) clearTimeout(timer);
        resolve(result.done === true ? null : result.value);
      };

      this.waiters.push(waiter);
    });
  }

  /** Everything queued right now, leaving the stream empty. */
  drain(): T[] {
    const queued = [...this.buffer];
    this.buffer.length = 0;
    return queued;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter({ value: undefined as never, done: true });
    }
    this.listeners.clear();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    for (;;) {
      const value = await this.next();
      if (value === null) return;
      yield value;
    }
  }
}
