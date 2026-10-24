import OpenAI from "openai";

// Adapted from SignLoop apps/web/lib/llm-client.ts.
// Source commit: 5d06ed2630386c4a9af78373ce998d31dbc1f776
// Environment reads were replaced with explicit configuration and injectable clients.

export type LlmProvider = "gemini" | "primary-openai-compatible" | "openrouter";

/** Native Gemini API generation; tried after the configured primary and before OpenRouter. */
export type GeminiProviderConfig = {
  readonly apiKey: string;
  readonly model: string;
};

export type PrimaryProviderConfig = {
  readonly baseURL: string;
  readonly apiKey?: string;
  readonly model: string;
};

export type OpenRouterProviderConfig = {
  readonly baseURL: string;
  readonly apiKey: string;
  readonly models?: readonly string[];
};

/**
 * Provider-only configuration derived from the service's validated startup config.
 * This module deliberately never reads process.env, so each request is deterministic
 * and unit tests can supply isolated provider settings.
 */
export type ProviderConfig = {
  readonly gemini?: GeminiProviderConfig;
  readonly primary?: PrimaryProviderConfig;
  readonly openRouter?: OpenRouterProviderConfig;
  readonly publicServiceUrl: string;
  readonly appName: string;
};

export type FetchImplementation = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export type OpenAiCompatibleClientOptions = {
  readonly timeoutMs?: number;
  readonly publicServiceUrl?: string;
  readonly appName?: string;
  readonly fetch?: FetchImplementation;
};

export type LlmFallbackLogger = Pick<Console, "warn">;

export type SafeProviderFailure = Readonly<{
  provider: LlmProvider;
  model: string;
  errorClass: string;
  statusCode?: number;
  providerCode?: string;
  upstreamRequestId?: string;
}>;

const SILENT_OPENAI_SDK_LOGGER = Object.freeze({
  error: () => {},
  warn: () => {},
  info: () => {},
  debug: () => {},
});

export function createRestrictedProviderFetch(input: {
  fetch: FetchImplementation;
  apiKey: string;
  publicServiceUrl?: string;
  appName?: string;
}): FetchImplementation {
  return async (resource, init) => {
    const sdkHeaders = new Headers(init?.headers);
    const headers = new Headers({
      Accept: "application/json",
      Authorization: `Bearer ${input.apiKey}`,
    });
    const contentType = sdkHeaders.get("content-type");
    if (contentType) headers.set("Content-Type", contentType);
    if (input.publicServiceUrl?.trim()) {
      headers.set("HTTP-Referer", input.publicServiceUrl.trim());
    }
    if (input.appName?.trim()) {
      headers.set("X-Title", input.appName.trim());
    }

    // Rebuild the outbound set from explicit service configuration. This neutralizes the SDK's
    // ambient OPENAI_CUSTOM_HEADERS escape hatch, including unrelated credential headers.
    return input.fetch.call(undefined, resource, { ...init, headers });
  };
}

/** All configured and eligible generation attempts were exhausted. */
export class GenerationUnavailableError extends Error {
  constructor(readonly failures: readonly SafeProviderFailure[]) {
    super("All configured generation providers are unavailable");
    this.name = "GenerationUnavailableError";
  }
}

function getErrorClass(error: unknown): string {
  const candidate =
    error instanceof Error ? error.name || "Error" : typeof error;
  return /^[A-Za-z0-9_.-]{1,100}$/u.test(candidate) ? candidate : "Error";
}

function safeMachineValue(value: unknown, maximum = 100): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return new RegExp(`^[A-Za-z0-9_.:-]{1,${maximum}}$`, "u").test(trimmed)
    ? trimmed
    : undefined;
}

function safeStatusCode(value: unknown): number | undefined {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 100 &&
    value <= 599
    ? value
    : undefined;
}

function providerStatusCode(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const record = error as Record<string, unknown>;
  return safeStatusCode(record.status) ?? safeStatusCode(record.statusCode);
}

/** Retry another OpenRouter model only when the failure could plausibly be model-specific/transient. */
export function isEligibleOpenRouterFallback(error: unknown): boolean {
  const statusCode = providerStatusCode(error);
  if (statusCode === undefined) return true;
  if (statusCode === 400 && typeof error === "object" && error !== null) {
    const record = error as Record<string, unknown>;
    const nested =
      typeof record.error === "object" && record.error !== null
        ? (record.error as Record<string, unknown>)
        : {};
    const code = safeMachineValue(record.code) ?? safeMachineValue(nested.code);
    if (
      code === "model_not_found" ||
      code === "model_not_available" ||
      code === "invalid_model"
    ) {
      return true;
    }
  }
  return ![400, 401, 403, 405, 413, 422].includes(statusCode);
}

/** Reduce any SDK/provider error to the only metadata allowed at the logging boundary. */
export function safeProviderFailureMetadata(
  provider: LlmProvider,
  model: string,
  error: unknown,
): SafeProviderFailure {
  const record =
    typeof error === "object" && error !== null
      ? (error as Record<string, unknown>)
      : {};
  const nested =
    typeof record.error === "object" && record.error !== null
      ? (record.error as Record<string, unknown>)
      : {};
  const headers = record.headers instanceof Headers ? record.headers : null;
  const statusCode =
    safeStatusCode(record.status) ?? safeStatusCode(record.statusCode);
  const providerCode =
    safeMachineValue(record.code) ?? safeMachineValue(nested.code);
  const upstreamRequestId =
    safeMachineValue(record.request_id, 128) ??
    safeMachineValue(record.requestId, 128) ??
    safeMachineValue(record.requestID, 128) ??
    safeMachineValue(headers?.get("x-request-id"), 128);

  return {
    provider,
    model,
    errorClass: getErrorClass(error),
    ...(statusCode !== undefined ? { statusCode } : {}),
    ...(providerCode ? { providerCode } : {}),
    ...(upstreamRequestId ? { upstreamRequestId } : {}),
  };
}

export function validateProviderBaseUrl(baseURL: string): string {
  const resolvedBaseUrl = baseURL.trim();
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

  return resolvedBaseUrl;
}

export function createOpenAiCompatibleClient(
  baseURL: string,
  apiKey?: string,
  options?: OpenAiCompatibleClientOptions,
): OpenAI {
  const resolvedBaseUrl = validateProviderBaseUrl(baseURL);
  // The SDK requires a non-empty value even when a compatible endpoint intentionally
  // does not require authentication. Configured credentials pass through unchanged.
  const resolvedApiKey = apiKey?.trim() || "not-required";
  const defaultHeaders: Record<string, string> = {};

  if (options?.publicServiceUrl?.trim()) {
    defaultHeaders["HTTP-Referer"] = options.publicServiceUrl.trim();
  }
  if (options?.appName?.trim()) {
    defaultHeaders["X-Title"] = options.appName.trim();
  }
  defaultHeaders.Accept = "application/json";
  defaultHeaders.Authorization = `Bearer ${resolvedApiKey}`;

  const fetchImplementation = options?.fetch ?? globalThis.fetch;
  if (typeof fetchImplementation !== "function") {
    throw new Error("LLM fetch implementation is unavailable");
  }

  return new OpenAI({
    apiKey: resolvedApiKey,
    // Pin every ambient OpenAI SDK option that could leak request data or unrelated credentials.
    // In particular, OPENAI_LOG=debug otherwise logs full prompt bodies and provider URLs.
    adminAPIKey: null,
    organization: null,
    project: null,
    webhookSecret: null,
    baseURL: resolvedBaseUrl,
    timeout: options?.timeoutMs ?? 60_000,
    maxRetries: 0,
    logLevel: "off",
    logger: SILENT_OPENAI_SDK_LOGGER,
    defaultHeaders,
    fetch: createRestrictedProviderFetch({
      fetch: fetchImplementation,
      apiKey: resolvedApiKey,
      ...(options?.publicServiceUrl
        ? { publicServiceUrl: options.publicServiceUrl }
        : {}),
      ...(options?.appName ? { appName: options.appName } : {}),
    }),
  });
}
