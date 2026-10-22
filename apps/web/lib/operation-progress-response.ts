import {
  PROGRESS_MEDIA_TYPE,
  type ReportProgress,
} from "@/lib/operation-progress";

/** Execute inside the stream's start promise, including all finally/release work. No detached job.
 * Before the first stage, preflight failures retain their original HTTP response and headers.
 * Cancellation aborts work; it never skips its cleanup or queues more output.
 */
export async function operationProgressResponse(
  request: Request,
  execute: (request: Request, progress?: ReportProgress) => Promise<Response>,
): Promise<Response> {
  const optedIn = request.headers
    .get("accept")
    ?.split(",")
    .some((part) => {
      const [type, ...parameters] = part.trim().split(";");
      return (
        type === PROGRESS_MEDIA_TYPE &&
        !parameters.some((p) => /^\s*q=0(?:\.0*)?\s*$/.test(p))
      );
    });
  if (!optedIn) return execute(request);

  const abort = new AbortController();
  const signal = AbortSignal.any([request.signal, abort.signal]);
  const operationRequest = new Request(request, { signal });
  let resolve!: (response: Response) => void;
  let reject!: (error: unknown) => void;
  const response = new Promise<Response>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  let complete!: () => void;
  const completed = new Promise<void>((resolve) => {
    complete = resolve;
  });
  let started = false;
  let canceled = false;
  const encoder = new TextEncoder();
  const seen = new Set<string>();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      // Allow stream assignment before the first stage publishes its Response.
      await Promise.resolve();
      const send = (event: unknown) => {
        if (!canceled)
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      };
      try {
        const result = await execute(operationRequest, (stage, headers) => {
          signal.throwIfAborted();
          if (seen.has(stage)) return;
          seen.add(stage); // At most one event per stage, independent of consumer speed.
          if (!started) {
            started = true;
            const responseHeaders = new Headers(headers);
            responseHeaders.set("Content-Type", PROGRESS_MEDIA_TYPE);
            responseHeaders.set("Cache-Control", "no-store");
            responseHeaders.set("X-Content-Type-Options", "nosniff");
            resolve(new Response(stream, { headers: responseHeaders }));
          }
          send({ type: "stage", stage });
        });
        if (!started) resolve(result);
        else {
          send({
            type: "result",
            status: result.status,
            headers: Object.fromEntries(result.headers),
            body: await result.json(),
          });
        }
        if (!canceled) controller.close();
      } catch (error) {
        if (!started) reject(error);
        else if (!canceled) {
          send({
            type: "result",
            status: 500,
            headers: {},
            body: { error: "Operation failed. Please try again." },
          });
          controller.close();
        }
      } finally {
        complete();
      }
    },
    cancel(reason) {
      canceled = true;
      abort.abort(
        reason ?? new DOMException("Operation canceled", "AbortError"),
      );
      return completed;
    },
  });
  return response;
}
