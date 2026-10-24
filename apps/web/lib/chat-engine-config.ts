import type { ChatProviderCandidate } from "@repo/chat-engine/routing";
import type { HttpFetchConfig } from "@repo/chat-engine/http-fetch";
import type { ImageGenerationConfig } from "@repo/chat-engine/image-generation";
import type { UrlReaderConfig } from "@repo/chat-engine/url-reader";
import type { WebSearchConfig } from "@repo/chat-engine/web-search";
import {
  APP_NAME,
  isOpenRouterModel,
  OPENROUTER_API_KEY,
  OPENROUTER_BASE_URL,
  PRIMARY_LLM_API_KEY,
  PRIMARY_LLM_BASE_URL,
  SITE_URL,
} from "@/lib/llm-client";
import {
  IMAGE_GENERATION_MODEL,
  orderOpenRouterModels,
} from "@/lib/model-settings";

// The chat engine never reads the environment. These builders map this deployment's variables
// to its explicit configuration. Tool settings are read on every call, as the engine modules used
// to; provider settings come from the module-level values in llm-client and model-settings.

export function webSearchConfig(): WebSearchConfig {
  return {
    provider: process.env.WEB_SEARCH_PROVIDER,
    braveApiKey: process.env.BRAVE_SEARCH_API_KEY,
    firecrawlApiKey: process.env.FIRECRAWL_API_KEY,
    geminiApiKey: process.env.GEMINI_API_KEY,
    geminiModel: process.env.GEMINI_SEARCH_MODEL,
  };
}

export function urlReaderConfig(): UrlReaderConfig {
  return {
    firecrawlApiKey: process.env.FIRECRAWL_API_KEY,
    jinaApiKey: process.env.JINA_API_KEY,
  };
}

export function httpFetchConfig(): HttpFetchConfig {
  return {
    userAgent: `SignLoop/1.0 (+${process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000"})`,
  };
}

/**
 * SignLoop's provider chain: the user's primary model on the configured endpoint, then the
 * OpenRouter chain. A pinned OpenRouter model skips the primary endpoint and heads that chain.
 */
export function chatProviderCandidates(
  primaryModel: string | null,
): ChatProviderCandidate[] {
  const pinnedFallback = isOpenRouterModel(primaryModel);
  const headers = { "HTTP-Referer": SITE_URL, "X-Title": APP_NAME };
  return [
    ...(primaryModel && !pinnedFallback && PRIMARY_LLM_BASE_URL
      ? [
          {
            kind: "openai-responses" as const,
            provider: "primary-openai-compatible",
            model: primaryModel,
            baseURL: PRIMARY_LLM_BASE_URL,
            apiKey: PRIMARY_LLM_API_KEY,
            headers,
          },
        ]
      : []),
    ...(OPENROUTER_API_KEY
      ? orderOpenRouterModels(primaryModel).map((model) => ({
          kind: "openai-responses" as const,
          provider: "openrouter",
          model,
          baseURL: OPENROUTER_BASE_URL,
          apiKey: OPENROUTER_API_KEY,
          headers,
        }))
      : []),
  ];
}

/** Images are generated on the primary endpoint. */
export function imageGenerationConfig(): ImageGenerationConfig {
  return {
    baseURL: PRIMARY_LLM_BASE_URL,
    apiKey: PRIMARY_LLM_API_KEY,
    model: IMAGE_GENERATION_MODEL,
    referer: SITE_URL,
    appName: APP_NAME,
  };
}
