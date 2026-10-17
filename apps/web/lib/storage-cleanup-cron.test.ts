import { afterEach, describe, expect, it, vi } from "vitest";

const { flushStorageDeletions } = vi.hoisted(() => ({
  flushStorageDeletions: vi.fn(),
}));

vi.mock("@/lib/storage-cleanup", () => ({ flushStorageDeletions }));

import { GET } from "@/app/api/cron/storage-cleanup/route";

const originalSecret = process.env.CRON_SECRET;

afterEach(() => {
  if (originalSecret === undefined) {
    delete process.env.CRON_SECRET;
  } else {
    process.env.CRON_SECRET = originalSecret;
  }
  flushStorageDeletions.mockReset();
  vi.useRealTimers();
});

describe("storage cleanup cron", () => {
  it("rejects requests when the configured secret is missing or incorrect", async () => {
    delete process.env.CRON_SECRET;
    const request = new Request("http://localhost/api/cron/storage-cleanup");
    expect((await GET(request)).status).toBe(401);

    process.env.CRON_SECRET = "expected-secret";
    expect((await GET(request)).status).toBe(401);
    expect(
      (
        await GET(
          new Request("http://localhost/api/cron/storage-cleanup", {
            headers: { authorization: "Bearer wrong-secret" },
          }),
        )
      ).status,
    ).toBe(401);
    expect(flushStorageDeletions).not.toHaveBeenCalled();
  });

  it("drains full batches and stops after a partial batch", async () => {
    process.env.CRON_SECRET = "expected-secret";
    flushStorageDeletions
      .mockResolvedValueOnce({ claimed: 20, completed: 19 })
      .mockResolvedValueOnce({ claimed: 3, completed: 3 });

    const response = await GET(
      new Request("http://localhost/api/cron/storage-cleanup", {
        headers: { authorization: "Bearer expected-secret" },
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      claimed: 23,
      completed: 22,
      batches: 2,
      moreMayRemain: false,
    });
    expect(flushStorageDeletions).toHaveBeenCalledTimes(2);
    expect(flushStorageDeletions).toHaveBeenCalledWith(20, { deadline: expect.any(Number) });
  });

  it("passes one absolute deadline to every batch and leaves time for settlement", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    process.env.CRON_SECRET = "expected-secret";
    flushStorageDeletions.mockImplementation((_limit, { deadline }) => new Promise((resolve) => {
      setTimeout(() => resolve({ claimed: 20, completed: 16 }), Math.min(230_000, deadline - Date.now()) + 5_000);
    }));

    const result = GET(new Request("http://localhost/api/cron/storage-cleanup", {
      headers: { authorization: "Bearer expected-secret" },
    }));
    await vi.advanceTimersByTimeAsync(245_000);
    const response = await result;
    expect(await response.json()).toEqual({ claimed: 40, completed: 32, batches: 2, moreMayRemain: true });
    expect(flushStorageDeletions.mock.calls).toEqual([
      [20, { deadline: 240_000 }],
      [20, { deadline: 240_000 }],
    ]);
    expect(Date.now()).toBeLessThan(300_000);
  });
});
