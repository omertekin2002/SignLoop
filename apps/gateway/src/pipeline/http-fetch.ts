// Ported from SignLoop apps/web/lib/http-fetch.ts at 3f830abaae4d47dedecabea3fca57a4899a8f688.
import { getErrorMessage } from "../utils";
import { validatePublicHttpUrl } from "./url-reader";
import { fetch, type Response } from "undici/index.js";
import { createPublicHttpDispatcher } from "./public-http-dispatcher";

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

/** Decode only the useful prefix plus one lookahead character, with a separate byte ceiling. */
async function readBoundedBody(
  response: Response,
): Promise<{ text: string; truncated: boolean }> {
  const decoder = resolveDecoder(response.headers.get("content-type"));
  if (!response.body) return { text: "", truncated: false };
  const reader = response.body.getReader();
  let text = "";
  let total = 0;
  let truncated = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.byteLength) continue;
      let offset = 0;
      while (
        offset < value.byteLength &&
        total < MAX_RESPONSE_BYTES &&
        text.length <= MAX_FETCH_RESPONSE_CHARACTERS
      ) {
        const length = Math.min(
          value.byteLength - offset,
          MAX_RESPONSE_BYTES - total,
          MAX_FETCH_RESPONSE_CHARACTERS + 1 - text.length,
        );
        text += decoder.decode(value.subarray(offset, offset + length), {
          stream: true,
        });
        total += length;
        offset += length;
      }
      if (
        text.length > MAX_FETCH_RESPONSE_CHARACTERS ||
        total >= MAX_RESPONSE_BYTES
      ) {
        truncated = true;
        break;
      }
    }
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  text += decoder.decode();
  return {
    text: text.slice(0, MAX_FETCH_RESPONSE_CHARACTERS),
    truncated: truncated || text.length > MAX_FETCH_RESPONSE_CHARACTERS,
  };
}

/**
 * GETs a public http(s) URL and returns the raw body. Redirects are followed manually so each
 * destination is re-checked; non-2xx responses are returned rather than thrown, so the model can
 * read the status and adapt instead of only learning that "something failed".
 */
export async function httpGet(
  input: string,
  options?: { signal?: AbortSignal; publicServiceUrl?: string },
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
          "User-Agent": `SignLoop/1.0 (+${options?.publicServiceUrl || "http://localhost:3000"})`,
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

      const { text, truncated } = await readBoundedBody(response);
      return {
        url: target.href,
        status: response.status,
        contentType: response.headers.get("content-type"),
        body: text,
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
