// Gateway provider configuration and policies around the @repo/chat-engine provider chain.
// This module never reads process.env: every request uses the validated startup configuration.
import type { SafeProviderFailure } from "@repo/chat-engine/provider-failure";

export type { SafeProviderFailure } from "@repo/chat-engine/provider-failure";

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

/** Provider-only configuration derived from the service's validated startup config. */
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

export type LlmFallbackLogger = Pick<Console, "warn">;

/**
 * Fetch for OpenAI-compatible AI SDK providers. Rebuild the outbound headers from explicit service
 * configuration. This neutralizes the SDK's ambient OPENAI_CUSTOM_HEADERS escape hatch, including
 * unrelated credential headers.
 */
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
