// Public entry point of the chat engine: the agent loop, its tools, provider routing, and the
// helpers applications use around a turn (replay, citations, failure metadata). The package never
// reads the environment; callers pass every endpoint, key and model explicitly.
//
// Narrow subpath imports (`@repo/chat-engine/<module>`) load only one module and its imports.
// Use them from browser bundles (chat-history-shared, bounded-response) and wherever a module
// should not pull in the AI SDK.

export {
  CHAT_MAX_OUTPUT_TOKENS,
  describeToolInput,
  generateChatReply,
  generateChatReplyStream,
  type ChatEngineOptions,
  type ChatMessage,
  type ChatReply,
  type ChatReplyStreamChunk,
  type ChatRole,
  type ChatToolActivity,
  type ChatToolContext,
  type ChatToolExtension,
  type ChatToolsConfig,
  type ContractEvidence,
  type CoreChatToolName,
} from "./chat";
export {
  createRoutedModel,
  DEFAULT_FIRST_CHUNK_TIMEOUT_MS,
  FirstChunkTimeoutError,
  type ChatLanguageModel,
  type ChatProviderCandidate,
  type ChatProviderOptions,
  type ChatRoutingOptions,
  type ProviderMilestone,
} from "./routing";
export {
  CONTRACT_EGRESS_ERROR,
  CONTRACT_WINDOW_CHARACTERS,
  createContractEgressGuard,
  createHttpGetTool,
  createImageTool,
  createUrlReaderTool,
  excerptContract,
  fenceUntrusted,
  MAX_HTTP_FETCHES,
  MAX_IMAGE_GENERATIONS,
  MAX_URL_READS,
  type ContractEgressGuard,
  type ContractExcerpt,
} from "./chat-tools";
export {
  resolveWebSearchProvider,
  searchWeb,
  WebSearchError,
  type WebSearchConfig,
  type WebSearchResponse,
} from "./web-search";
export {
  GeminiWebSearchError,
  type GeminiSearchConfig,
  type WebSearchMetadata,
  type WebSearchSource,
} from "./gemini-search";
export { readUrl, UrlReadError, type UrlReaderConfig } from "./url-reader";
export { httpGet, HttpFetchError, type HttpFetchConfig } from "./http-fetch";
export {
  generateImageReply,
  type GeneratedImageReply,
  type ImageGenerationConfig,
} from "./image-generation";
export {
  createOpenAiCompatibleClient,
  type OpenAiCompatibleClientOptions,
} from "./openai-client";
export {
  compactAgentMessages,
  parseAgentMessages,
  parseWebSources,
  MAX_AGENT_STATE_CHARACTERS,
  MAX_SOURCE_CATALOG_CHARACTERS,
  MAX_SOURCE_COUNT,
} from "./chat-agent-history";
export {
  createChatSourceCatalog,
  SOURCE_CATALOG_FULL_MESSAGE,
  SourceCatalogFullError,
} from "./chat-source-catalog";
export {
  appendWebSourcesToMessage,
  normalizeCitationMarkers,
  verifyFigures,
  type FigureVerification,
} from "./web-citations";
export {
  safeProviderFailureMetadata,
  type SafeProviderFailure,
} from "./provider-failure";
export { TEXT_REASONING_EFFORT } from "./reasoning-policy";
export { buildAuthoritativeUtcTimeContext } from "./chat-time";
