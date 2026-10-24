import { describe, expect, it } from "vitest";

import { InferenceSemaphore } from "../src/concurrency";

describe("InferenceSemaphore", () => {
  it("rejects excess work and releases each slot once", () => {
    const semaphore = new InferenceSemaphore(1);
    const release = semaphore.tryAcquire();

    expect(release).not.toBeNull();
    expect(semaphore.active).toBe(1);
    expect(semaphore.tryAcquire()).toBeNull();

    release?.();
    release?.();
    expect(semaphore.active).toBe(0);
    expect(semaphore.tryAcquire()).not.toBeNull();
  });
});
