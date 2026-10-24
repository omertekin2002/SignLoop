// The gateway's provider chain for @repo/chat-engine: configured primary, native Gemini, then
// OpenRouter. The engine owns routing between candidates; this module only describes them.
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { TEXT_REASONING_EFFORT } from "@repo/chat-engine/reasoning-policy";
import {
  DEFAULT_FIRST_CHUNK_TIMEOUT_MS,
  type ChatProviderCandidate,
} from "@repo/chat-engine/routing";
import { OPENROUTER_FALLBACK_MODELS } from "../config";
import {
  createRestrictedProviderFetch,
  isEligibleOpenRouterFallback,
  type FetchImplementation,
  type LlmProvider,
  type ProviderConfig,
} from "./llm-client";

export const FIRST_CHUNK_TIMEOUT_MS = DEFAULT_FIRST_CHUNK_TIMEOUT_MS;
// Gemini streams nothing while it thinks, and high thinking can run well past the default opening
// deadline. Its first-party API rarely accepts a request and then goes silent, so it waits longer.
export const GEMINI_FIRST_CHUNK_TIMEOUT_MS = 90_000;
const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

/** How long a provider may take to start answering a step before the next provider is tried. */
export function openingDeadlineMs(
  provider: LlmProvider,
  override?: number,
): number {
  return (
    override ??
    (provider === "gemini"
      ? GEMINI_FIRST_CHUNK_TIMEOUT_MS
      : FIRST_CHUNK_TIMEOUT_MS)
  );
}

/** Configured generation providers in the order each model step tries them. */
export function listProviderCandidates(
  config: Pick<ProviderConfig, "gemini" | "primary" | "openRouter">,
): { provider: LlmProvider; model: string }[] {
  return [
    ...(config.primary
      ? [
          {
            provider: "primary-openai-compatible" as const,
            model: config.primary.model,
          },
        ]
      : []),
    ...(config.gemini
      ? [{ provider: "gemini" as const, model: config.gemini.model }]
      : []),
    ...(config.openRouter
      ? (config.openRouter.models ?? OPENROUTER_FALLBACK_MODELS).map(
          (model) => ({
            provider: "openrouter" as const,
            model,
          }),
        )
      : []),
  ];
}

/**
 * Engine candidates for the configured providers. OpenAI-compatible endpoints go through the
 * restricted fetch, which rebuilds outbound headers from explicit configuration. An explicit
 * opening deadline applies to every provider; otherwise Gemini waits longer than the rest.
 */
export function buildProviderCandidates(
  config: ProviderConfig,
  options: { fetch?: FetchImplementation; firstChunkTimeoutMs?: number } = {},
): ChatProviderCandidate[] {
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  const openAiCompatible = (
    provider: LlmProvider,
    model: string,
    baseURL: string,
    apiKey: string | undefined,
  ): ChatProviderCandidate => {
    const key = apiKey || "not-required";
    return {
      kind: "openai-responses",
      provider,
      model,
      baseURL,
      apiKey: key,
      headers: {
        "HTTP-Referer": config.publicServiceUrl,
        "X-Title": config.appName,
      },
      fetch: createRestrictedProviderFetch({
        fetch: fetchImplementation,
        apiKey: key,
        publicServiceUrl: config.publicServiceUrl,
        appName: config.appName,
      }) as typeof globalThis.fetch,
    };
  };
  return listProviderCandidates(config).map(
    ({ provider, model }): ChatProviderCandidate => {
      switch (provider) {
        case "primary-openai-compatible":
          return openAiCompatible(
            provider,
            model,
            config.primary!.baseURL,
            config.primary!.apiKey,
          );
        case "gemini":
          return {
            kind: "language-model",
            provider,
            model,
            // Explicit key and base URL keep ambient GOOGLE_GENERATIVE_AI_* settings out of
            // routing. Gemini authenticates with x-goog-api-key, so the OpenAI-shaped restricted
            // fetch (which rebuilds a Bearer header) does not apply here.
            languageModel: createGoogleGenerativeAI({
              apiKey: config.gemini!.apiKey,
              baseURL: GEMINI_BASE_URL,
              fetch: fetchImplementation as typeof globalThis.fetch,
            }).languageModel(model),
            firstChunkTimeoutMs: openingDeadlineMs(
              provider,
              options.firstChunkTimeoutMs,
            ),
            providerOptions: {
              google: { thinkingConfig: { thinkingLevel: TEXT_REASONING_EFFORT } },
            },
          };
        case "openrouter":
          return {
            ...openAiCompatible(
              provider,
              model,
              config.openRouter!.baseURL,
              config.openRouter!.apiKey,
            ),
            // Another OpenRouter model cannot fix a rejected request or credential.
            shouldFallback: isEligibleOpenRouterFallback,
          };
      }
    },
  );
}
