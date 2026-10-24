import { withAbort } from "@repo/chat-engine/bounded-response";
import {
  PROGRESS_MEDIA_TYPE,
  isOperationStage,
  isRecord,
  type OperationStage,
} from "@/lib/operation-progress";

/** Axios-compatible response fields preserve existing error/quota UI for late stream failures. */
export class OperationRequestError extends Error {
  readonly response: {
    status: number;
    data: Record<string, unknown>;
    headers: Record<string, string>;
  };
  constructor(
    status: number,
    data: Record<string, unknown>,
    headers: Record<string, string> = {},
  ) {
    super(
      typeof data.error === "string"
        ? data.error
        : "Operation failed. Please try again.",
    );
    this.name = "OperationRequestError";
    this.response = { status, data, headers };
  }
}
const invalidResponse = () =>
  new OperationRequestError(502, {
    error:
      "The operation response was interrupted or invalid. Refresh to check whether it was saved before trying again.",
  });
const MAX_RESPONSE_BYTES = 65_536;

export async function readOperationResponse<T>(
  response: Response,
  options: {
    signal?: AbortSignal;
    onStage?: (stage: OperationStage) => void;
    validate: (value: unknown) => value is T;
  },
): Promise<T> {
  const { signal, onStage, validate } = options;
  const reader = response.body?.getReader();
  if (!reader) throw invalidResponse();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const streaming =
    response.headers.get("content-type")?.split(";")[0] === PROGRESS_MEDIA_TYPE;
  let buffer = "";
  let bytes = 0;
  let stageIndex = -1;
  let stagePath: string[] | undefined;
  const terminal = (
    status: number,
    body: unknown,
    headers: Record<string, string>,
  ): T => {
    if (!isRecord(body)) throw invalidResponse();
    if (status < 200 || status >= 300)
      throw new OperationRequestError(status, body, headers);
    if (!validate(body)) throw invalidResponse();
    return body;
  };
  try {
    for (;;) {
      const { done, value } = await withAbort(reader.read(), signal);
      signal?.throwIfAborted();
      if (value) {
        bytes += value.byteLength;
        if (bytes > MAX_RESPONSE_BYTES) throw invalidResponse();
        buffer += decoder.decode(value, { stream: true });
      }
      if (done) buffer += decoder.decode();
      if (streaming) {
        let newline: number;
        while ((newline = buffer.indexOf("\n")) !== -1) {
          signal?.throwIfAborted();
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          const event: unknown = JSON.parse(line);
          if (!isRecord(event)) throw invalidResponse();
          if (event.type === "stage" && isOperationStage(event.stage)) {
            if (!stagePath)
              stagePath =
                event.stage === "preparing"
                  ? ["preparing", "analyzing", "saving"]
                  : ["uploading", "extracting", "saving"];
            const next = stagePath.indexOf(event.stage);
            if (next !== stageIndex + 1) throw invalidResponse();
            stageIndex = next;
            onStage?.(event.stage);
          } else if (
            event.type === "result" &&
            Number.isInteger(event.status) &&
            typeof event.status === "number" &&
            event.status >= 200 &&
            event.status <= 599 &&
            isRecord(event.headers) &&
            Object.values(event.headers).every((v) => typeof v === "string")
          ) {
            if (buffer.trim()) throw invalidResponse();
            if (event.status < 300 && stageIndex !== 2) throw invalidResponse();
            return terminal(
              event.status,
              event.body,
              event.headers as Record<string, string>,
            );
          } else throw invalidResponse();
        }
        if (done) throw invalidResponse(); // EOF is never success without a terminal result.
      } else if (done) {
        return terminal(
          response.status,
          JSON.parse(buffer),
          Object.fromEntries(response.headers),
        );
      }
    }
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    if (error instanceof OperationRequestError) throw error;
    throw invalidResponse();
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function postOperation<T>(
  path: string,
  options: {
    body?: FormData;
    signal?: AbortSignal;
    onStage?: (stage: OperationStage) => void;
    validate: (value: unknown) => value is T;
  },
): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method: "POST",
    body: options.body,
    signal: options.signal,
    headers: { Accept: PROGRESS_MEDIA_TYPE },
  });
  return readOperationResponse(response, options);
}
