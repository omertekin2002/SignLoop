import { getErrorMessage } from "@/lib/utils";

export const MAX_PAGE_CHARACTERS = 12_000;
const READ_TIMEOUT_MS = 30_000;
const FIRECRAWL_SCRAPE_URL = "https://api.firecrawl.dev/v2/scrape";
const JINA_READER_URL = "https://r.jina.ai/";
const MAX_TITLE_CHARACTERS = 240;

export type ReadUrlResult = {
  title: string;
  url: string;
  content: string;
  truncated: boolean;
  provider: "firecrawl" | "jina";
};

export class UrlReadError extends Error {
  constructor(
    message: string,
    readonly publicMessage: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "UrlReadError";
  }
}

const INVALID_ADDRESS = "Only public http(s) web addresses can be read.";
const BLOCKED_HOST = /^(localhost|.*\.localhost|.*\.local|.*\.internal)$/i;
const PRIVATE_IPV4 =
  /^(0\.|10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/;

/** Accepts only routable public http(s) URLs so the reader cannot be pointed at internal services. */
export function validatePublicHttpUrl(input: string): URL {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new UrlReadError(`Invalid URL: ${input.slice(0, 200)}`, INVALID_ADDRESS);
  }
  if (input.length > 2048 || (url.protocol !== "http:" && url.protocol !== "https:"))
    throw new UrlReadError(`Unsupported URL: ${url.protocol}`, INVALID_ADDRESS);
  if (url.username || url.password)
    throw new UrlReadError("URLs with credentials are not allowed", INVALID_ADDRESS);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const isIpv4 = /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
  if (
    BLOCKED_HOST.test(host) ||
    (isIpv4 && PRIVATE_IPV4.test(host)) ||
    (!isIpv4 && host.includes(":")) ||
    !host.includes(".")
  )
    throw new UrlReadError(`Blocked host: ${host}`, INVALID_ADDRESS);
  return url;
}

function sanitizeTitle(value: unknown, fallback: string): string {
  const title =
    typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  return (title || fallback).slice(0, MAX_TITLE_CHARACTERS);
}

async function readWithFirecrawl(
  url: URL,
  apiKey: string,
  signal: AbortSignal,
): Promise<Omit<ReadUrlResult, "truncated">> {
  const response = await fetch(FIRECRAWL_SCRAPE_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      url: url.href,
      formats: ["markdown"],
      onlyMainContent: true,
      parsers: ["pdf"],
      timeout: READ_TIMEOUT_MS,
    }),
    signal,
  });
  if (!response.ok) throw new Error(`Firecrawl responded with ${response.status}`);
  const payload = (await response.json()) as {
    success?: boolean;
    data?: { markdown?: string; metadata?: { title?: string; sourceURL?: string } };
  };
  const content = payload.data?.markdown?.trim();
  if (!payload.success || !content) throw new Error("Firecrawl returned no markdown");
  return {
    provider: "firecrawl",
    title: sanitizeTitle(payload.data?.metadata?.title, url.hostname),
    url: payload.data?.metadata?.sourceURL || url.href,
    content,
  };
}

async function readWithJina(
  url: URL,
  apiKey: string | null,
  signal: AbortSignal,
): Promise<Omit<ReadUrlResult, "truncated">> {
  const response = await fetch(`${JINA_READER_URL}${url.href}`, {
    headers: {
      Accept: "application/json",
      "X-Return-Format": "markdown",
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
    signal,
  });
  if (!response.ok) throw new Error(`Jina Reader responded with ${response.status}`);
  const payload = (await response.json()) as {
    data?: { title?: string; url?: string; content?: string };
  };
  const content = payload.data?.content?.trim();
  if (!content) throw new Error("Jina Reader returned no content");
  return {
    provider: "jina",
    title: sanitizeTitle(payload.data?.title, url.hostname),
    url: payload.data?.url || url.href,
    content,
  };
}

/** Fetches the readable text of a public page or PDF through a hosted reader; never contacts the host directly. */
export async function readUrl(
  input: string,
  options?: { signal?: AbortSignal },
): Promise<ReadUrlResult> {
  options?.signal?.throwIfAborted();
  const url = validatePublicHttpUrl(input);
  const signal = AbortSignal.any([
    AbortSignal.timeout(READ_TIMEOUT_MS),
    ...(options?.signal ? [options.signal] : []),
  ]);
  const firecrawlKey = process.env.FIRECRAWL_API_KEY?.trim() || null;
  const jinaKey = process.env.JINA_API_KEY?.trim() || null;
  try {
    let result: Omit<ReadUrlResult, "truncated"> | null = null;
    if (firecrawlKey) {
      try {
        result = await readWithFirecrawl(url, firecrawlKey, signal);
      } catch (error) {
        if (signal.aborted) throw error;
        console.warn("Firecrawl read failed, falling back to Jina:", getErrorMessage(error));
      }
    }
    result ??= await readWithJina(url, jinaKey, signal);
    const truncated = result.content.length > MAX_PAGE_CHARACTERS;
    return {
      ...result,
      content: truncated ? result.content.slice(0, MAX_PAGE_CHARACTERS) : result.content,
      truncated,
    };
  } catch (error) {
    if (error instanceof UrlReadError) throw error;
    if (options?.signal?.aborted) throw error;
    const message = getErrorMessage(error);
    throw new UrlReadError(
      `Reading ${url.href} failed: ${message}`,
      /timed? ?out|TimeoutError/i.test(message)
        ? "Reading that page timed out. Try again or use search instead."
        : "That page could not be read. Try another address or search for the information instead.",
      { cause: error },
    );
  }
}
