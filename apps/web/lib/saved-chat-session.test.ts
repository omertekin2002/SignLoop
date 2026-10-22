import { describe, expect, it, vi } from "vitest";
import { createSavedChatSession } from "./saved-chat-session";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function newDraft() {
  const session = createSavedChatSession();
  session.select(null, true);
  return session;
}

const signal = () => new AbortController().signal;

describe("lazy saved-chat creation", () => {
  it("shares an in-flight creation and keeps the same session through saved-ID promotion", async () => {
    const session = newDraft();
    const response = deferred<string>();
    const create = vi.fn(() => response.promise);
    const run = session.beginRun(signal());
    const first = run.resolveThread(create);
    const duplicate = run.resolveThread(create);
    expect(create).toHaveBeenCalledTimes(1);
    response.resolve("created");
    expect(await first).toBe("created");
    expect(await duplicate).toBe("created");

    session.select("created", true);
    expect(run.isCurrent()).toBe(true);
    // A failed generation can be retried against the already-created thread.
    expect(await session.beginRun(signal()).resolveThread(create)).toBe("created");
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("retains a usable draft session after creation fails and permits a single retry", async () => {
    const session = newDraft();
    const create = vi.fn()
      .mockRejectedValueOnce(new Error("Thread service unavailable"))
      .mockResolvedValue("retried");
    const failedRun = session.beginRun(signal());
    await expect(failedRun.resolveThread(create)).rejects.toThrow("Thread service unavailable");
    expect(failedRun.isCurrent()).toBe(true);
    expect(await session.beginRun(signal()).resolveThread(create)).toBe("retried");
    expect(create).toHaveBeenCalledTimes(2);
  });

  it.each(["existing", "temporary", "new chat", "account change"])(
    "rejects a late creation after switching to %s, even if the transport ignores cancellation",
    async (destination) => {
      const session = newDraft();
      const response = deferred<string>();
      const run = session.beginRun(signal());
      const selected = vi.fn();
      const send = vi.fn();
      const request = run.resolveThread(() => response.promise).then((id) => {
        selected(id);
        send(id);
      });
      const rejection = expect(request).rejects.toMatchObject({ name: "AbortError" });
      if (destination === "existing") session.select("other", true);
      else if (destination === "temporary") session.select(null, false);
      else session.invalidate(); // New chat / auth remount destroys the old session.
      response.resolve("late");
      await rejection;
      expect(selected).not.toHaveBeenCalled();
      expect(send).not.toHaveBeenCalled();
      if (destination === "existing") {
        const create = vi.fn();
        expect(await session.beginRun(signal()).resolveThread(create)).toBe("other");
        expect(create).not.toHaveBeenCalled();
      }
    },
  );

  it("does not revive a run after leaving and returning to the same selection", async () => {
    const session = newDraft();
    const response = deferred<string>();
    const oldRun = session.beginRun(signal());
    const request = oldRun.resolveThread(() => response.promise);
    const rejection = expect(request).rejects.toMatchObject({ name: "AbortError" });
    session.select("other", true);
    session.select(null, true);
    const next = deferred<string>();
    const create = vi.fn(() => next.promise);
    const newRun = session.beginRun(signal());
    const newRequest = newRun.resolveThread(create);
    response.resolve("late");
    await rejection;
    // Settling the abandoned request cannot clear the newer request's deduplication.
    const duplicate = newRun.resolveThread(create);
    expect(create).toHaveBeenCalledTimes(1);
    next.resolve("current");
    expect(await newRequest).toBe("current");
    expect(await duplicate).toBe("current");
  });

  it("stops a cancelled send while retaining its late-created ID for a retry of the same draft", async () => {
    const session = newDraft();
    const controller = new AbortController();
    const response = deferred<string>();
    const run = session.beginRun(controller.signal);
    const request = run.resolveThread(() => response.promise);
    const rejection = expect(request).rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    const createAgain = vi.fn(async () => "unnecessary-duplicate");
    const retry = session.beginRun(signal()).resolveThread(createAgain);
    response.resolve("cancelled");
    await rejection;
    expect(run.isCurrent()).toBe(false);
    expect(await retry).toBe("cancelled");
    expect(await session.beginRun(signal()).resolveThread(createAgain)).toBe("cancelled");
    expect(createAgain).not.toHaveBeenCalled();
  });
});
