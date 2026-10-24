import type { HttpFetchConfig } from "@repo/chat-engine/http-fetch";
import type { UrlReaderConfig } from "@repo/chat-engine/url-reader";
import type { WebSearchConfig } from "@repo/chat-engine/web-search";

// The chat engine never reads the environment. These builders map this deployment's variables
// to its explicit configuration, read on every call as the engine modules used to.

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
