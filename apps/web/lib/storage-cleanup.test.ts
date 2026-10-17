import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  deleteObject,
  claimStorageDeletions,
  completeStorageDeletion,
  deferStorageDeletion,
} = vi.hoisted(() => ({
  deleteObject: vi.fn(),
  claimStorageDeletions: vi.fn(),
  completeStorageDeletion: vi.fn(),
  deferStorageDeletion: vi.fn(),
}));

vi.mock("@/lib/object-storage", () => ({ deleteObject }));
vi.mock("@/lib/server-db", () => ({
  claimStorageDeletions,
  completeStorageDeletion,
  deferStorageDeletion,
}));

import { flushStorageDeletions } from "@/lib/storage-cleanup";

const pending = Array.from({ length: 12 }, (_, i) => ({
  id: `id-${i}`,
  storageKey: `key-${i}`,
  token: `token-${i}`,
}));

function slowDelete(_key: string, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, 60);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  claimStorageDeletions.mockResolvedValue(pending);
  deleteObject.mockResolvedValue(undefined);
  completeStorageDeletion.mockResolvedValue(undefined);
  deferStorageDeletion.mockResolvedValue(undefined);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.resetAllMocks();
  vi.restoreAllMocks();
});

describe("storage cleanup deadlines", () => {
  it("does not claim work for an expired deadline or an already aborted caller", async () => {
    expect(await flushStorageDeletions(20, { deadline: 0 })).toEqual({
      claimed: 0,
      completed: 0,
    });
    expect(
      await flushStorageDeletions(20, { signal: AbortSignal.abort() }),
    ).toEqual({ claimed: 0, completed: 0 });
    expect(claimStorageDeletions).not.toHaveBeenCalled();
  });

  it("preserves the default CLI batch behavior and token-scoped acknowledgements", async () => {
    expect(await flushStorageDeletions()).toEqual({
      claimed: 12,
      completed: 12,
    });
    expect(claimStorageDeletions).toHaveBeenCalledWith(20);
    expect(deleteObject).toHaveBeenCalledTimes(12);
    for (const item of pending) {
      expect(completeStorageDeletion).toHaveBeenCalledWith(item.id, item.token);
    }
    expect(deferStorageDeletion).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("defers failures and continues deleting other objects", async () => {
    deleteObject.mockRejectedValueOnce(new Error("storage unavailable"));
    expect(await flushStorageDeletions(12, { deadline: 100 })).toEqual({
      claimed: 12,
      completed: 11,
    });
    expect(deferStorageDeletion).toHaveBeenCalledExactlyOnceWith(
      pending[0]!.id,
      pending[0]!.token,
    );
    expect(completeStorageDeletion).toHaveBeenCalledTimes(11);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("aborts in-flight deletes mid-batch and defers all unscheduled claims", async () => {
    deleteObject.mockImplementation(slowDelete);
    const result = flushStorageDeletions(12, { deadline: 100 });
    await vi.advanceTimersByTimeAsync(100);
    expect(await result).toEqual({ claimed: 12, completed: 4 });
    expect(deleteObject).toHaveBeenCalledTimes(8);
    expect(deleteObject.mock.calls.every(([, signal]) => signal.aborted)).toBe(
      true,
    );
    expect(completeStorageDeletion).toHaveBeenCalledTimes(4);
    expect(deferStorageDeletion).toHaveBeenCalledTimes(8);
    for (const item of pending.slice(4)) {
      expect(deferStorageDeletion).toHaveBeenCalledWith(item.id, item.token);
    }
    expect(vi.getTimerCount()).toBe(0);
  });

  it("settles every claim if the deadline passes during the non-cancellable claim query", async () => {
    claimStorageDeletions.mockImplementation(
      () =>
        new Promise((resolve) => {
          setTimeout(() => resolve(pending), 150);
        }),
    );
    const result = flushStorageDeletions(12, { deadline: 100 });
    await vi.advanceTimersByTimeAsync(150);
    expect(await result).toEqual({ claimed: 12, completed: 0 });
    expect(deleteObject).not.toHaveBeenCalled();
    expect(deferStorageDeletion).toHaveBeenCalledTimes(12);
  });

  it("finishes acknowledgements after expiry without dispatching more objects", async () => {
    completeStorageDeletion.mockImplementation(
      () =>
        new Promise((resolve) => {
          setTimeout(resolve, 150);
        }),
    );
    const result = flushStorageDeletions(12, { deadline: 100 });
    await vi.advanceTimersByTimeAsync(150);
    expect(await result).toEqual({ claimed: 12, completed: 4 });
    expect(deleteObject).toHaveBeenCalledTimes(4);
    expect(deferStorageDeletion).toHaveBeenCalledTimes(8);
  });

  it("propagates caller cancellation to in-flight deletes and releases remaining claims", async () => {
    const controller = new AbortController();
    deleteObject.mockImplementation(slowDelete);
    const result = flushStorageDeletions(12, { signal: controller.signal });
    await vi.advanceTimersByTimeAsync(10);
    controller.abort();
    expect(await result).toEqual({ claimed: 12, completed: 0 });
    expect(deleteObject).toHaveBeenCalledTimes(4);
    expect(deferStorageDeletion).toHaveBeenCalledTimes(12);
  });

  it("attempts to settle other claims even if a defer fails", async () => {
    claimStorageDeletions.mockImplementation(async () => {
      vi.setSystemTime(100);
      return pending;
    });
    deferStorageDeletion.mockRejectedValueOnce(
      new Error("database unavailable"),
    );
    await expect(flushStorageDeletions(12, { deadline: 100 })).rejects.toThrow(
      "Storage cleanup settlement failed",
    );
    expect(deferStorageDeletion).toHaveBeenCalledTimes(12);
    expect(deleteObject).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
