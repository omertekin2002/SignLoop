import { getErrorMessage } from "@/lib/utils";
import { validatePublicHttpUrl } from "@/lib/url-reader";
import { fetch, type Response } from "undici/index.js";
import { createPublicHttpDispatcher } from "@/lib/public-http-dispatcher";

// Raw HTTP GET for the chat agent. Unlike lib/url-reader.ts, which proxies through a hosted
// reader and returns readability-extracted prose, this contacts the target host directly and
// returns the response body verbatim — the shape APIs answer in, and the shape a model can quote
// a single field out of instead of paraphrasing a summary.
//
// Every hop passes the URL guard, and the dispatcher validates DNS addresses at
// connection time. Connections use those verified addresses without a second lookup.

export const MAX_FETCH_RESPONSE_CHARACTERS = 12_000;
const FETCH_TIMEOUT_MS = 30_000;
const MAX_REDIRECTS = 5;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export type HttpGetResult = {
  /** Final address after redirects, so citations point at what actually answered. */
  url: string;
  status: number;
  contentType: string | null;
  body: string;
  truncated: boolean;
};

export class HttpFetchError extends Error {
  constructor(
    message: string,
    readonly publicMessage: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "HttpFetchError";
  }
}

function resolveDecoder(contentType: string | null): TextDecoder {
  const charset = contentType?.match(/charset=["']?([\w-]+)/i)?.[1];
  if (charset) {
    try {
      return new TextDecoder(charset);
    } catch {
      // An unknown charset label is not worth failing the whole read over.
    }
  }
  return new TextDecoder("utf-8");
}

/** Reads at most MAX_RESPONSE_BYTES so a large or endless body cannot exhaust the function. */
async function readBoundedBody(
  response: Response,
): Promise<{ text: string; truncated: boolean }> {
  const decoder = resolveDecoder(response.headers.get("content-type"));
  if (!response.body) return { text: "", truncated: false };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.byteLength) continue;
      const remaining = MAX_RESPONSE_BYTES - total;
      if (value.byteLength >= remaining) {
        chunks.push(value.subarray(0, remaining));
        truncated = true;
        break;
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  const text = chunks.map((chunk) => decoder.decode(chunk, { stream: true })).join("");
  return { text: text + decoder.decode(), truncated };
}

/**
 * GETs a public http(s) URL and returns the raw body. Redirects are followed manually so each
 * destination is re-checked; non-2xx responses are returned rather than thrown, so the model can
 * read the status and adapt instead of only learning that "something failed".
 */
export async function httpGet(
  input: string,
  options?: { signal?: AbortSignal },
): Promise<HttpGetResult> {
  options?.signal?.throwIfAborted();
  const signal = AbortSignal.any([
    AbortSignal.timeout(FETCH_TIMEOUT_MS),
    ...(options?.signal ? [options.signal] : []),
  ]);
  let target = validatePublicHttpUrl(input);
  const dispatcher = createPublicHttpDispatcher();

  try {
    for (let hop = 0; ; hop++) {
      const response = await fetch(target, {
        dispatcher,
        method: "GET",
        redirect: "manual",
        headers: {
          Accept: "application/json, text/plain;q=0.9, */*;q=0.8",
          "User-Agent": `SignLoop/1.0 (+${process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000"})`,
        },
        signal,
      });

      const location = response.headers.get("location");
      if (REDIRECT_STATUSES.has(response.status) && location) {
        await response.body?.cancel().catch(() => {});
        if (hop >= MAX_REDIRECTS) {
          throw new HttpFetchError(
            `Too many redirects from ${input}`,
            "That address redirected too many times.",
          );
        }
        // Re-validate: the guard on the model-supplied URL says nothing about where it points next.
        target = validatePublicHttpUrl(new URL(location, target).href);
        continue;
      }

      const { text, truncated: bodyTruncated } = await readBoundedBody(response);
      const truncated = bodyTruncated || text.length > MAX_FETCH_RESPONSE_CHARACTERS;
      return {
        url: target.href,
        status: response.status,
        contentType: response.headers.get("content-type"),
        body: truncated ? text.slice(0, MAX_FETCH_RESPONSE_CHARACTERS) : text,
        truncated,
      };
    }
  } catch (error) {
    if (error instanceof HttpFetchError) throw error;
    // A blocked host or malformed redirect target arrives as UrlReadError, which already carries a
    // publicMessage; let it through untouched.
    if (error instanceof Error && "publicMessage" in error) throw error;
    if (options?.signal?.aborted) throw error;
    const message = getErrorMessage(error);
    throw new HttpFetchError(
      `Fetching ${target.href} failed: ${message}`,
      /timed? ?out|TimeoutError/i.test(message)
        ? "That request timed out. Try again or use a different address."
        : "That address could not be fetched. Check the URL or try a different source.",
      { cause: error },
    );
  } finally {
    // Also close sockets for cancelled, redirected, oversized, or failed responses.
    await dispatcher.destroy();
  }
}
