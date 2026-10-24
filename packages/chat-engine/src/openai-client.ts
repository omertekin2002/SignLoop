import OpenAI from "openai";

type ProviderFetch = (
  resource: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export type OpenAiCompatibleClientOptions = {
  /** Per-request client timeout; the SDK default here is 60 seconds. */
  timeoutMs?: number;
  /** Sent as HTTP-Referer, which OpenRouter uses for attribution. */
  referer?: string;
  /** Sent as X-Title. */
  appName?: string;
};

/**
 * Rebuild each request's headers from explicit settings. The OpenAI SDK merges the ambient
 * OPENAI_CUSTOM_HEADERS variable into every request, which could send unrelated credentials to
 * the primary endpoint or OpenRouter.
 */
function createRestrictedProviderFetch(
  apiKey: string,
  options?: OpenAiCompatibleClientOptions,
): ProviderFetch {
  return (resource, init) => {
    const headers = new Headers({
      Accept: "application/json",
      Authorization: `Bearer ${apiKey}`,
      ...(options?.referer ? { "HTTP-Referer": options.referer } : {}),
      ...(options?.appName ? { "X-Title": options.appName } : {}),
    });
    const contentType = new Headers(init?.headers).get("content-type");
    if (contentType) headers.set("Content-Type", contentType);
    return fetch(resource, { ...init, headers });
  };
}

export function createOpenAiCompatibleClient(
  baseURL: string,
  apiKey?: string,
  options?: OpenAiCompatibleClientOptions,
): OpenAI {
  const resolvedBaseUrl = baseURL.trim();
  // The OpenAI client requires a non-empty value even when the compatible endpoint does not use
  // authentication. Real configured credentials still pass through unchanged.
  const resolvedApiKey = apiKey?.trim() || "not-required";

  if (!resolvedBaseUrl) {
    throw new Error("LLM base URL is not configured");
  }

  let parsedBaseUrl: URL;
  try {
    parsedBaseUrl = new URL(resolvedBaseUrl);
  } catch {
    throw new Error("LLM base URL is invalid");
  }
  if (
    parsedBaseUrl.protocol !== "https:" &&
    parsedBaseUrl.protocol !== "http:"
  ) {
    throw new Error("LLM base URL must use HTTP or HTTPS");
  }

  return new OpenAI({
    apiKey: resolvedApiKey,
    // Pin ambient SDK settings that could send unrelated credentials to these endpoints.
    // OPENAI_LOG=debug would otherwise log full request bodies, including contract text.
    adminAPIKey: null,
    organization: null,
    project: null,
    webhookSecret: null,
    logLevel: "off",
    baseURL: resolvedBaseUrl,
    timeout: options?.timeoutMs ?? 60_000,
    maxRetries: 0,
    fetch: createRestrictedProviderFetch(resolvedApiKey, options),
  });
}
