import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { del, rm } = vi.hoisted(() => ({ del: vi.fn(), rm: vi.fn() }));
vi.mock("@vercel/blob", () => ({ del, put: vi.fn() }));
vi.mock("node:fs/promises", () => ({ default: { rm } }));

import { deleteObject } from "@/lib/object-storage";

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv("LOCAL_STORAGE_PATH", "/test-uploads");
  del.mockResolvedValue(undefined);
  rm.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.resetAllMocks();
  vi.restoreAllMocks();
});

describe("object deletion cancellation", () => {
  it.each([
    ["blob:pending/file.pdf", "pending/file.pdf"],
    [
      "https://store.public.blob.vercel-storage.com/file.pdf",
      "https://store.public.blob.vercel-storage.com/file.pdf",
    ],
  ])(
    "propagates cancellation to an in-flight Blob delete: %s",
    async (key, blobKey) => {
      const controller = new AbortController();
      del.mockImplementation(
        (_key: string, { abortSignal }: { abortSignal: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            abortSignal.addEventListener(
              "abort",
              () => reject(abortSignal.reason),
              { once: true },
            );
          }),
      );
      const result = deleteObject(key, controller.signal);
      const rejection = expect(result).rejects.toThrow("deadline reached");
      setTimeout(() => controller.abort(new Error("deadline reached")), 100);
      await vi.advanceTimersByTimeAsync(100);
      await rejection;
      expect(del).toHaveBeenCalledWith(blobKey, {
        abortSignal: expect.any(AbortSignal),
      });
      expect(rm).not.toHaveBeenCalled();
    },
  );

  it("retains the per-object timeout without a caller signal", async () => {
    // Node's native AbortSignal.timeout does not use Vitest's fake timer clock.
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
      const controller = new AbortController();
      setTimeout(
        () => controller.abort(new DOMException("timed out", "TimeoutError")),
        ms,
      );
      return controller.signal;
    });
    del.mockImplementation(
      (_key: string, { abortSignal }: { abortSignal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          abortSignal.addEventListener(
            "abort",
            () => reject(abortSignal.reason),
            { once: true },
          );
        }),
    );
    const result = deleteObject("blob:pending/file.pdf");
    const rejection = expect(result).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(29_999);
    expect(del.mock.calls[0]![1].abortSignal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await rejection;
  });

  it.each(["blob:pending/file.pdf", "local/file.pdf"])(
    "does not dispatch already cancelled deletes: %s",
    async (key) => {
      await expect(deleteObject(key, AbortSignal.abort())).rejects.toThrow();
      expect(del).not.toHaveBeenCalled();
      expect(rm).not.toHaveBeenCalled();
    },
  );

  it("removes both the local object and its metadata normally", async () => {
    await deleteObject("local/file.pdf");
    expect(rm.mock.calls).toEqual([
      ["/test-uploads/local/file.pdf", { force: true }],
      ["/test-uploads/local/file.pdf.meta.json", { force: true }],
    ]);
    expect(del).not.toHaveBeenCalled();
  });

  it("does not start a metadata deletion after cancellation during local removal", async () => {
    const controller = new AbortController();
    rm.mockImplementationOnce(
      () => new Promise((resolve) => setTimeout(resolve, 100)),
    );
    const result = deleteObject("local/file.pdf", controller.signal);
    const rejection = expect(result).rejects.toThrow();
    setTimeout(() => controller.abort(), 50);
    await vi.advanceTimersByTimeAsync(100);
    await rejection;
    expect(rm).toHaveBeenCalledTimes(1);
  });
});
