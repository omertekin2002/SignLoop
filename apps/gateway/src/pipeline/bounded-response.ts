// Ported from SignLoop apps/web/lib/bounded-response.ts at 3f830abaae4d47dedecabea3fca57a4899a8f688.
/** Await cancellable work without retaining abort listeners after it completes. */
export function withAbort<T>(
  promise: PromiseLike<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) return Promise.resolve(promise);
  if (signal.aborted) {
    void Promise.resolve(promise).catch(() => {});
    return Promise.reject(signal.reason);
  }
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve(promise)
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}

export async function readBoundedResponse(
  response: Response,
  signal?: AbortSignal,
  maxBytes = 1_048_576,
): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (declared > maxBytes) {
    void response.body?.cancel().catch(() => {});
    throw new Error("Provider response is too large");
  }
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await withAbort(reader.read(), signal);
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new Error("Provider response is too large");
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString("utf8");
  } catch (error) {
    void reader.cancel(error).catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}

export async function readBoundedJson(
  response: Response,
  signal?: AbortSignal,
  maxBytes?: number,
): Promise<unknown> {
  return JSON.parse(await readBoundedResponse(response, signal, maxBytes));
}
