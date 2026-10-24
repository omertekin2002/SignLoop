import type { WebToolsConfig } from "../config";
// Ported from SignLoop apps/web/lib/web-search.ts at 3f830abaae4d47dedecabea3fca57a4899a8f688.
import { readBoundedJson } from "./bounded-response";
import { getErrorMessage, isRecord } from "../utils";
import {
  searchWeb as geminiGroundedSearch,
  type WebSearchSource,
} from "./gemini-search";

// Traditional web search: a ranked list of pages the model can choose to read, rather than a
// synthesized answer. Gemini grounding (lib/gemini-search.ts) returns a brief written by another
// model, which reads as finished evidence and discourages follow-up research; it is kept here only
// as the fallback for deployments that have no dedicated search key.
//
// Search results are deliberately NOT registered as citable sources. A page becomes citable when
// read_url or http_get actually fetches it, so a citation always points at text the model saw.

const SEARCH_TIMEOUT_MS = 20_000;
export const MAX_WEB_SEARCH_RESULTS = 8;
const MAX_RESULTS = MAX_WEB_SEARCH_RESULTS;
const MAX_TITLE_CHARACTERS = 240;
const MAX_SNIPPET_CHARACTERS = 600;
const MAX_URL_CHARACTERS = 2_048;

export type WebSearchResult = WebSearchSource;
export type WebSearchProviderName = "brave" | "firecrawl" | "gemini";

export type WebSearchResponse = {
  provider: WebSearchProviderName;
  query: string;
  results: WebSearchResult[];
  /** Only the Gemini grounding fallback synthesizes prose; the search providers return null. */
  brief: string | null;
};

export class WebSearchError extends Error {
  constructor(
    message: string,
    readonly publicMessage: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "WebSearchError";
  }
}

/**
 * An explicit WEB_SEARCH_PROVIDER wins. Otherwise Brave is preferred over Firecrawl because a
 * Firecrawl key is often present only for read_url, while a Brave key is unambiguously for search.
 */
export function resolveWebSearchProvider(
  config: WebToolsConfig = {},
): WebSearchProviderName | null {
  const configured = config.provider;
  if (
    configured === "brave" ||
    configured === "firecrawl" ||
    configured === "gemini"
  ) {
    return configured;
  }
  if (config.braveApiKey) return "brave";
  if (config.firecrawlApiKey) return "firecrawl";
  if (config.geminiApiKey) return "gemini";
  return null;
}

function sanitizeLine(value: unknown, maxLength: number): string {
  return typeof value === "string"
    ? value
        .replace(/\p{Cc}+/gu, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, maxLength)
    : "";
}

function normalizeUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_URL_CHARACTERS) return null;
  try {
    const url = new URL(trimmed);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

/** Both Brave and Firecrawl name the snippet field `description`. */
function toResults(rawResults: unknown): WebSearchResult[] {
  const entries = Array.isArray(rawResults) ? rawResults : [];
  const results: WebSearchResult[] = [];
  const seen = new Set<string>();

  for (const entry of entries) {
    if (!isRecord(entry)) continue;
    const url = normalizeUrl(entry.url);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const snippet = sanitizeLine(entry.description, MAX_SNIPPET_CHARACTERS);
    results.push({
      title:
        sanitizeLine(entry.title, MAX_TITLE_CHARACTERS).replace(
          /[[\]\\]/g,
          "",
        ) || new URL(url).hostname,
      url,
      snippet: snippet || null,
    });
    if (results.length >= MAX_RESULTS) break;
  }

  return results;
}

async function searchBrave(
  query: string,
  signal: AbortSignal,
  config: WebToolsConfig,
): Promise<WebSearchResult[]> {
  const apiKey = config.braveApiKey;
  if (!apiKey) throw new Error("BRAVE_SEARCH_API_KEY is not set");
  const url = new URL("https://api.search.brave.com/res/v1/web/search");
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(MAX_RESULTS));
  const response = await fetch(url, {
    headers: { Accept: "application/json", "X-Subscription-Token": apiKey },
    signal,
  });
  if (!response.ok)
    throw new Error(`Brave search responded with ${response.status}`);
  const payload: unknown = await readBoundedJson(response, signal);
  const web = isRecord(payload) && isRecord(payload.web) ? payload.web : null;
  return toResults(web?.results);
}

async function searchFirecrawl(
  query: string,
  signal: AbortSignal,
  config: WebToolsConfig,
): Promise<WebSearchResult[]> {
  const apiKey = config.firecrawlApiKey;
  if (!apiKey) throw new Error("FIRECRAWL_API_KEY is not set");
  const response = await fetch("https://api.firecrawl.dev/v2/search", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    // No scrapeOptions: the model decides which results are worth a full read, which keeps the
    // search cheap and leaves the read (and its citation) an explicit step.
    body: JSON.stringify({ query, limit: MAX_RESULTS, sources: ["web"] }),
    signal,
  });
  if (!response.ok)
    throw new Error(`Firecrawl search responded with ${response.status}`);
  const payload: unknown = await readBoundedJson(response, signal);
  const data =
    isRecord(payload) && isRecord(payload.data) ? payload.data : null;
  return toResults(data?.web);
}

export async function searchWeb(
  query: string,
  options?: { signal?: AbortSignal; config?: WebToolsConfig },
): Promise<WebSearchResponse> {
  options?.signal?.throwIfAborted();
  const trimmed = query.trim();
  if (!trimmed || trimmed.length > 2000) {
    throw new WebSearchError(
      "Invalid search query",
      "That search query is not valid. Try a shorter one.",
    );
  }

  const config = options?.config ?? {};
  const provider = resolveWebSearchProvider(config);
  if (!provider) {
    throw new WebSearchError(
      "No web search provider is configured",
      "Web search is not configured. Set BRAVE_SEARCH_API_KEY, FIRECRAWL_API_KEY, or GEMINI_API_KEY.",
    );
  }

  if (provider === "gemini") {
    // Already wrapped in GeminiWebSearchError, which carries its own publicMessage.
    const grounded = await geminiGroundedSearch(trimmed, {
      signal: options?.signal,
      apiKey: config.geminiApiKey ?? undefined,
      model: config.geminiModel,
    });
    return {
      provider,
      query: grounded.metadata.query || trimmed,
      results: grounded.metadata.sources,
      brief: grounded.brief,
    };
  }

  const signal = AbortSignal.any([
    AbortSignal.timeout(SEARCH_TIMEOUT_MS),
    ...(options?.signal ? [options.signal] : []),
  ]);

  try {
    const results =
      provider === "brave"
        ? await searchBrave(trimmed, signal, config)
        : await searchFirecrawl(trimmed, signal, config);
    if (!results.length) {
      throw new WebSearchError(
        `${provider} returned no results for ${trimmed}`,
        "That search returned no results. Try different keywords.",
      );
    }
    return { provider, query: trimmed, results, brief: null };
  } catch (error) {
    if (error instanceof WebSearchError) throw error;
    if (options?.signal?.aborted) throw error;
    const message = getErrorMessage(error);
    throw new WebSearchError(
      `${provider} search failed: ${message}`,
      /timed? ?out|TimeoutError/i.test(message)
        ? "Web search timed out. Please try again."
        : "Web search failed. Try a different query, or explain that verification was unavailable.",
      { cause: error },
    );
  }
}
