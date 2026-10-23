function progressDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
import { describe, expect, it, vi } from "vitest";
import { operationProgressResponse } from "./operation-progress-response";
import {
  readOperationResponse,
  OperationRequestError,
} from "./operation-progress-client";
import {
  PROGRESS_MEDIA_TYPE,
  isUploadResult,
  isAnalysisOperationResult,
} from "./operation-progress";

const deferred = <T>() => progressDeferred<T>();
const req = (accept = PROGRESS_MEDIA_TYPE) =>
  new Request("http://localhost/operation", {
    method: "POST",
    headers: { Accept: accept },
  });
const stage = (stage: string) => ({ type: "stage", stage });
const result = (body: unknown, status = 200, headers = {}) => ({
  type: "result",
  status,
  headers,
  body,
});
const response = (events: unknown[]) =>
  new Response(events.map((e) => JSON.stringify(e)).join("\n") + "\n", {
    headers: { "Content-Type": PROGRESS_MEDIA_TYPE },
  });
const success = [
  stage("uploading"),
  stage("extracting"),
  stage("saving"),
  result({ success: true, warning: "Partial text" }),
];

describe("operation progress lifecycle", () => {
  it("retains JSON identity, request identity and headers without opt in (including q=0)", async () => {
    for (const accept of ["application/json", `${PROGRESS_MEDIA_TYPE};q=0`]) {
      const original = req(accept);
      const json = Response.json(
        { error: "quota", quota: { remaining: 0 } },
        { status: 429, headers: { "Retry-After": "20" } },
      );
      const execute = vi.fn(async () => json);
      expect(await operationProgressResponse(original, execute)).toBe(json);
      expect(execute).toHaveBeenCalledWith(original);
    }
  });
  it("returns untouched preflight errors even when opted in", async () => {
    const json = Response.json({ error: "Unauthorized" }, { status: 401 });
    expect(await operationProgressResponse(req(), async () => json)).toBe(json);
  });
  it("delivers stages during pending work and waits for persistence AND release before success", async () => {
    const extract = deferred<void>();
    const persist = deferred<void>();
    const release = deferred<void>();
    const response = await operationProgressResponse(
      req(),
      async (_, report) => {
        report?.("uploading");
        report?.("extracting");
        await extract.promise;
        report?.("saving");
        await persist.promise;
        await release.promise;
        return Response.json({ success: true, warning: "Partial text" });
      },
    );
    const onStage = vi.fn();
    const finished = vi.fn();
    const reading = readOperationResponse(response, {
      onStage,
      validate: isUploadResult,
    }).then(finished);
    await vi.waitFor(() =>
      expect(onStage.mock.calls.flat()).toEqual(["uploading", "extracting"]),
    );
    expect(finished).not.toHaveBeenCalled();
    extract.resolve();
    await vi.waitFor(() => expect(onStage).toHaveBeenLastCalledWith("saving"));
    persist.resolve();
    await Promise.resolve();
    expect(finished).not.toHaveBeenCalled();
    release.resolve();
    await reading;
    expect(finished).toHaveBeenCalledWith({
      success: true,
      warning: "Partial text",
    });
  });
  it("cancels underlying work but keeps its cleanup alive until settled, exactly once", async () => {
    const pending = deferred<void>();
    const released = deferred<void>();
    const cleanup = vi.fn();
    let signal!: AbortSignal;
    const response = await operationProgressResponse(
      req(),
      async (request, report) => {
        signal = request.signal;
        try {
          report?.("preparing");
          await pending.promise;
          signal.throwIfAborted();
          return Response.json({ analysisId: "id" });
        } finally {
          cleanup();
          released.resolve();
        }
      },
    );
    const reader = response.body!.getReader();
    await reader.read();
    const canceling = reader.cancel();
    await vi.waitFor(() => expect(signal.aborted).toBe(true));
    expect(cleanup).not.toHaveBeenCalled();
    pending.resolve();
    await released.promise;
    await canceling;
    expect(cleanup).toHaveBeenCalledOnce();
  });
  it("bounds duplicate stage emissions and emits one terminal error on unexpected failure", async () => {
    const response = await operationProgressResponse(
      req(),
      async (_, report) => {
        for (let i = 0; i < 1000; i++) report?.("uploading");
        throw new Error("private db details");
      },
    );
    const events = (await response.text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({ type: "result", status: 500 });
    expect(JSON.stringify(events)).not.toContain("private");
  });
});

describe("operation progress reader", () => {
  it("validates the persisted result and preserves warnings", async () => {
    const onStage = vi.fn();
    expect(
      await readOperationResponse(response(success), {
        onStage,
        validate: isUploadResult,
      }),
    ).toEqual({ success: true, warning: "Partial text" });
    expect(onStage.mock.calls.flat()).toEqual([
      "uploading",
      "extracting",
      "saving",
    ]);
  });
  it.each([400, 401, 404, 409, 422, 429, 500, 503])(
    "reconstructs late %i status, payload and headers",
    async (status) => {
      const body = {
        error: "Useful error",
        reason: "hourly",
        quota: { remaining: 0 },
      };
      await expect(
        readOperationResponse(
          response([
            stage("preparing"),
            result(body, status, { "retry-after": "30" }),
          ]),
          { validate: isAnalysisOperationResult },
        ),
      ).rejects.toMatchObject({
        response: { status, data: body, headers: { "retry-after": "30" } },
      });
    },
  );
  it("retains JSON reused results and preflight errors", async () => {
    expect(
      await readOperationResponse(
        Response.json({
          analysisId: "saved",
          message: "Analysis already exists",
        }),
        { validate: isAnalysisOperationResult },
      ),
    ).toMatchObject({ analysisId: "saved" });
    await expect(
      readOperationResponse(
        Response.json({ error: "Owner missing" }, { status: 404 }),
        { validate: isUploadResult },
      ),
    ).rejects.toMatchObject({ response: { status: 404 } });
  });
  it.each([
    [],
    [stage("uploading")],
    [stage("saving")],
    [stage("uploading"), stage("uploading")],
    [stage("uploading"), stage("analyzing")],
    [{ type: "stage", stage: "made-up" }],
    [result({ success: true })],
    [stage("uploading"), result({ success: true })],
    [...success.slice(0, 3), result({ success: false })],
    [...success.slice(0, 3), result({ success: true }, 200, { bad: 1 })],
    [...success, stage("saving")],
    [{ type: "unknown" }],
  ])(
    "rejects malformed, reordered or unfinished streams %j",
    async (...events) => {
      await expect(
        readOperationResponse(response(events), { validate: isUploadResult }),
      ).rejects.toBeInstanceOf(OperationRequestError);
    },
  );
  it("handles split UTF8 and records without requiring EOF after terminal", async () => {
    const encoded = new TextEncoder().encode(
      success.map((e) => JSON.stringify(e)).join("\n") + "\n",
    );
    let index = 0;
    const canceled = vi.fn();
    const stream = new ReadableStream({
      pull(controller) {
        if (index < encoded.length)
          controller.enqueue(encoded.slice(index, ++index));
      },
      cancel: canceled,
    });
    expect(
      await readOperationResponse(
        new Response(stream, {
          headers: { "Content-Type": PROGRESS_MEDIA_TYPE },
        }),
        { validate: isUploadResult },
      ),
    ).toMatchObject({ success: true });
    expect(canceled).toHaveBeenCalledOnce();
  });
  it.each([
    "{no json}\n",
    "x".repeat(65_537),
    '{"type":"stage","stage":"uploading"}',
  ])("rejects invalid/oversize/truncated input", async (body) => {
    await expect(
      readOperationResponse(
        new Response(body, {
          headers: { "Content-Type": PROGRESS_MEDIA_TYPE },
        }),
        { validate: isUploadResult },
      ),
    ).rejects.toMatchObject({ response: { status: 502 } });
  });
  it("aborts a pending read without later stage callbacks and cancels its reader once", async () => {
    const abort = new AbortController();
    const canceled = vi.fn();
    const onStage = vi.fn();
    const response = new Response(new ReadableStream({ cancel: canceled }), {
      headers: { "Content-Type": PROGRESS_MEDIA_TYPE },
    });
    const reading = readOperationResponse(response, {
      signal: abort.signal,
      onStage,
      validate: isUploadResult,
    });
    abort.abort(new DOMException("Stopped", "AbortError"));
    await expect(reading).rejects.toMatchObject({ name: "AbortError" });
    expect(canceled).toHaveBeenCalledOnce();
    expect(onStage).not.toHaveBeenCalled();
  });
});

it("stops within a buffered chunk if a stage callback aborts the operation", async () => {
  const abort = new AbortController();
  const onStage = vi.fn(() =>
    abort.abort(new DOMException("Stopped", "AbortError")),
  );
  await expect(
    readOperationResponse(response(success), {
      signal: abort.signal,
      onStage,
      validate: isUploadResult,
    }),
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(onStage).toHaveBeenCalledExactlyOnceWith("uploading");
});
