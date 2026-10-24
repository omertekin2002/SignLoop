export type ReleaseSlot = () => void;

/** A deliberately per-process inference concurrency limiter. */
export class InferenceSemaphore {
  readonly limit: number;
  #active = 0;

  constructor(limit: number) {
    if (!Number.isSafeInteger(limit) || limit <= 0) {
      throw new Error("Inference concurrency limit must be a positive integer");
    }
    this.limit = limit;
  }

  get active(): number {
    return this.#active;
  }

  tryAcquire(): ReleaseSlot | null {
    if (this.#active >= this.limit) return null;
    this.#active += 1;

    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#active -= 1;
    };
  }
}
