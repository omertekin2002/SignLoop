// Ported from SignLoop at 3f830abaae4d47dedecabea3fca57a4899a8f688.
import { expect, it, vi } from "vitest";
import {
  readBoundedResponse,
  withAbort,
} from "../src/pipeline/bounded-response";

it("cancels a chunked body when actual bytes exceed its budget", async () => {
  const cancel = vi.fn();
  const response = new Response(
    new ReadableStream({
      pull(controller) {
        controller.enqueue(new Uint8Array(8));
      },
      cancel,
    }),
  );
  await expect(readBoundedResponse(response, undefined, 10)).rejects.toThrow(
    /too large/,
  );
  expect(cancel).toHaveBeenCalledOnce();
});

it("cancels a stalled body when the request is aborted", async () => {
  const cancel = vi.fn();
  const response = new Response(new ReadableStream({ cancel }));
  const controller = new AbortController();
  const pending = readBoundedResponse(response, controller.signal);
  controller.abort(new Error("deadline"));
  await expect(pending).rejects.toThrow("deadline");
  expect(cancel).toHaveBeenCalledOnce();
});

it("handles an already-aborted operation without leaking its later rejection", async () => {
  const controller = new AbortController();
  controller.abort(new Error("canceled"));
  await expect(
    withAbort(Promise.reject(new Error("late")), controller.signal),
  ).rejects.toThrow("canceled");
});
