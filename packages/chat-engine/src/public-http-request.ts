import { pipeline, type Readable } from "node:stream";
import {
  constants as zlibConstants,
  createBrotliDecompress,
  createGunzip,
  createInflate,
  type BrotliDecompress,
  type Gunzip,
  type Inflate,
} from "node:zlib";
// Explicit package entry avoids Bun's built-in shim, which lacks custom dispatchers.
import { request, type Dispatcher } from "undici/index.js";

// undici's fetch() decodes compressed bodies through its own stream pipeline. Under Bun 1.3 that
// pipeline can stop delivering a gzip or brotli body after the headers and then ignore the abort
// signal, so the read never settles. This sends the GET through undici's core request API instead
// and decodes the body here, while keeping the caller's dispatcher (and its DNS guard).

const NULL_BODY_STATUSES = new Set([204, 205, 304]);
// Lenient like browsers: tolerate a truncated final block rather than failing the whole read.
const LENIENT = {
  flush: zlibConstants.Z_SYNC_FLUSH,
  finishFlush: zlibConstants.Z_SYNC_FLUSH,
};

export class UnsupportedContentEncodingError extends Error {
  constructor(readonly encoding: string) {
    super(`Unsupported content encoding: ${encoding}`);
    this.name = "UnsupportedContentEncodingError";
  }
}

type Decoder = Gunzip | Inflate | BrotliDecompress;

function createDecoder(coding: string): Decoder {
  switch (coding) {
    case "gzip":
    case "x-gzip":
      return createGunzip(LENIENT);
    case "deflate":
      return createInflate(LENIENT);
    case "br":
      return createBrotliDecompress({
        flush: zlibConstants.BROTLI_OPERATION_FLUSH,
        finishFlush: zlibConstants.BROTLI_OPERATION_FLUSH,
      });
    default:
      throw new UnsupportedContentEncodingError(coding);
  }
}

function toHeaders(raw: Record<string, string | string[] | undefined>): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(raw)) {
    if (value === undefined) continue;
    for (const item of Array.isArray(value) ? value : [value])
      headers.append(name, item);
  }
  return headers;
}

/** The body as a web stream whose cancel() also tears down the socket and any decoders. */
function toWebStream(
  body: Readable,
  decoders: Decoder[],
): ReadableStream<Uint8Array> {
  // pipeline() forwards errors and destruction along the chain; the last decoder is its output.
  if (decoders.length) pipeline([body, ...decoders], () => {});
  const output: Readable = decoders.at(-1) ?? body;
  const iterator = output[Symbol.asyncIterator]() as AsyncIterator<Buffer>;
  const destroy = (reason?: unknown) => {
    const error = reason instanceof Error ? reason : undefined;
    for (const stream of [body, ...decoders])
      if (!stream.destroyed) stream.destroy(error);
  };
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        try {
          const { done, value } = await iterator.next();
          if (done) controller.close();
          else controller.enqueue(new Uint8Array(value));
        } catch (error) {
          destroy(error);
          controller.error(error);
        }
      },
      cancel(reason) {
        destroy(reason);
      },
    },
    { highWaterMark: 0 },
  );
}

/**
 * GETs `url` without following redirects and returns a standard Response with the body already
 * decoded (gzip, deflate, br). Aborting `signal` aborts the request and any pending body read.
 */
export async function requestPublicHttp(
  url: URL,
  options: {
    dispatcher: Dispatcher;
    headers?: Record<string, string>;
    signal?: AbortSignal;
  },
): Promise<Response> {
  const { statusCode, headers, body } = await request(url, {
    dispatcher: options.dispatcher,
    method: "GET",
    headers: { "accept-encoding": "gzip, deflate, br", ...options.headers },
    signal: options.signal,
  });
  // undici's body emits an error when destroyed before its end (cancel, redirect, size cap);
  // readers see failures through the stream itself, so an unheard one must not crash the process.
  body.on("error", () => {});
  const responseHeaders = toHeaders(headers);
  if (NULL_BODY_STATUSES.has(statusCode)) {
    body.destroy();
    return new Response(null, { status: statusCode, headers: responseHeaders });
  }
  let decoders: Decoder[];
  try {
    // Codings are listed in the order they were applied, so undo them in reverse.
    decoders = (responseHeaders.get("content-encoding") ?? "")
      .split(",")
      .map((coding) => coding.trim().toLowerCase())
      .filter((coding) => coding && coding !== "identity")
      .reverse()
      .map(createDecoder);
  } catch (error) {
    body.destroy();
    throw error;
  }
  if (decoders.length) {
    // The decoded body no longer matches these.
    responseHeaders.delete("content-encoding");
    responseHeaders.delete("content-length");
  }
  return new Response(toWebStream(body, decoders), {
    status: statusCode,
    headers: responseHeaders,
  });
}
