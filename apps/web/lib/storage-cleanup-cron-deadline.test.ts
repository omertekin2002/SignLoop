import { afterEach, expect, it, vi } from "vitest";

const {
  del,
  claimStorageDeletions,
  completeStorageDeletion,
  deferStorageDeletion,
} = vi.hoisted(() => ({
  del: vi.fn(),
  claimStorageDeletions: vi.fn(),
  completeStorageDeletion: vi.fn(),
  deferStorageDeletion: vi.fn(),
}));

vi.mock("@vercel/blob", () => ({ del, put: vi.fn() }));
vi.mock("@/lib/server-db", () => ({
  claimStorageDeletions,
  completeStorageDeletion,
  deferStorageDeletion,
}));

import { GET } from "@/app/api/cron/storage-cleanup/route";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.resetAllMocks();
  vi.restoreAllMocks();
});

it("bounds real cron batches, aborts slow Blob requests, and settles every claimed token", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  vi.stubEnv("CRON_SECRET", "expected-secret");
  vi.spyOn(console, "error").mockImplementation(() => {});
  claimStorageDeletions.mockImplementation(async () =>
    Array.from({ length: 20 }, (_, i) => ({
      id: `id-${claimStorageDeletions.mock.calls.length}-${i}`,
      storageKey: `blob:object-${i}`,
      token: `token-${claimStorageDeletions.mock.calls.length}`,
    })),
  );
  // Successful deletions take 30s; the shared deadline must interrupt the final wave.
  // Database acknowledgements take another 100ms and must finish after cancellation.
  del.mockImplementation(
    (_key: string, { abortSignal }: { abortSignal: AbortSignal }) =>
      new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 30_000);
        abortSignal.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            reject(abortSignal.reason);
          },
          { once: true },
        );
      }),
  );
  const acknowledge = () =>
    new Promise<void>((resolve) => setTimeout(resolve, 100));
  completeStorageDeletion.mockImplementation(acknowledge);
  deferStorageDeletion.mockImplementation(acknowledge);

  const result = GET(
    new Request("http://localhost/api/cron/storage-cleanup", {
      headers: { authorization: "Bearer expected-secret" },
    }),
  );
  await vi.advanceTimersByTimeAsync(240_300);
  const response = await result;

  expect(await response.json()).toEqual({
    claimed: 40,
    completed: 28,
    batches: 2,
    moreMayRemain: true,
  });
  expect(claimStorageDeletions).toHaveBeenCalledTimes(2);
  expect(del).toHaveBeenCalledTimes(32);
  expect(completeStorageDeletion).toHaveBeenCalledTimes(28);
  expect(deferStorageDeletion).toHaveBeenCalledTimes(12);
  const settledTokens = [
    ...completeStorageDeletion.mock.calls,
    ...deferStorageDeletion.mock.calls,
  ].map(([id, token]) => `${id}:${token}`);
  expect(new Set(settledTokens).size).toBe(40);
  expect(
    del.mock.calls
      .slice(-4)
      .every(([, options]) => options.abortSignal.aborted),
  ).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
  expect(Date.now()).toBeLessThan(300_000);
});
