function progressDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
import { afterEach, describe, expect, it, vi } from "vitest";
const { post, remove, postOperation } = vi.hoisted(() => ({
  post: vi.fn(),
  remove: vi.fn(),
  postOperation: vi.fn(),
}));
vi.mock("./api-client", () => ({ apiClient: { post, delete: remove } }));
vi.mock("./operation-progress-client", () => ({ postOperation }));
import { uploadContract } from "./upload-contract";
import { MAX_UPLOAD_FILE_SIZE } from "./upload-constants";
import { withAbort } from "@repo/chat-engine/bounded-response";
afterEach(() => vi.resetAllMocks());
const file = new File(["Agreement"], "agreement.txt", { type: "text/plain" });
describe("uploadContract progress", () => {
  it("waits for the creation response after cancellation so it can remove the committed contract", async () => {
    const creation = progressDeferred<{ data: { id: string } }>();
    post.mockImplementation(
      (_path, _body, options?: { signal?: AbortSignal }) =>
        withAbort(creation.promise, options?.signal),
    );
    remove.mockResolvedValue({});
    const abort = new AbortController();
    const onStage = vi.fn();
    const outcome = uploadContract({
      file,
      title: "Agreement",
      signal: abort.signal,
      onStage,
    }).catch((error: unknown) => error);

    abort.abort(new DOMException("Upload dialog closed", "AbortError"));
    // The server committed, but its response had not reached the browser before closing.
    creation.resolve({ data: { id: "created-before-response" } });

    expect(await outcome).toMatchObject({ name: "AbortError" });
    expect(remove).toHaveBeenCalledExactlyOnceWith(
      "/contracts/created-before-response",
    );
    expect(postOperation).not.toHaveBeenCalled();
    expect(onStage.mock.calls.flat()).toEqual(["creating"]);
  });

  it("does not create a contract for an already canceled operation", async () => {
    const abort = new AbortController();
    abort.abort();
    const onStage = vi.fn();
    await expect(
      uploadContract({ file, title: "Agreement", signal: abort.signal, onStage }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(post).not.toHaveBeenCalled();
    expect(postOperation).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(onStage).not.toHaveBeenCalled();
  });

  it("reports creation immediately, waits for creation then starts upload with cancellation", async () => {
    const creation = progressDeferred<{ data: { id: string } }>();
    post.mockReturnValue(creation.promise);
    postOperation.mockResolvedValue({ success: true, warning: "Partial text" });
    const signal = new AbortController().signal;
    const onStage = vi.fn();
    const upload = uploadContract({
      file,
      title: " Agreement ",
      projectId: "project",
      signal,
      onStage,
    });
    expect(onStage).toHaveBeenCalledExactlyOnceWith("creating");
    expect(postOperation).not.toHaveBeenCalled();
    creation.resolve({ data: { id: "new" } });
    expect(await upload).toEqual({ success: true, warning: "Partial text" });
    expect(onStage.mock.calls.flat()).toEqual(["creating", "uploading"]);
    expect(post).toHaveBeenCalledWith(
      "/contracts",
      { title: "Agreement", projectId: "project" },
    );
    expect(postOperation).toHaveBeenCalledWith(
      "/contracts/new/upload",
      expect.objectContaining({ signal, onStage, body: expect.any(FormData) }),
    );
    expect(remove).not.toHaveBeenCalled();
  });
  it("preserves the useful upload error while cleanup fails", async () => {
    post.mockResolvedValue({ data: { id: "new" } });
    const error = new Error("Useful extraction failure");
    postOperation.mockRejectedValue(error);
    remove.mockRejectedValue(new Error("cleanup failed"));
    await expect(uploadContract({ file, title: "test" })).rejects.toBe(error);
    expect(remove).toHaveBeenCalledExactlyOnceWith("/contracts/new");
  });
  it("still cleans a known new contract if canceled after creation without starting upload", async () => {
    const abort = new AbortController();
    post.mockImplementation(async () => {
      abort.abort();
      return { data: { id: "new" } };
    });
    remove.mockResolvedValue({});
    await expect(
      uploadContract({ file, title: "test", signal: abort.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(postOperation).not.toHaveBeenCalled();
    expect(remove).toHaveBeenCalledOnce();
  });
  it("rejects an oversize file before creating anything", async () => {
    const oversized = { ...file, size: MAX_UPLOAD_FILE_SIZE + 1 } as File;
    await expect(
      uploadContract({ file: oversized, title: "test" }),
    ).rejects.toThrow("File too large");
    expect(post).not.toHaveBeenCalled();
  });
});
