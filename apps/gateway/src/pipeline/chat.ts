// The gateway's chat pipeline: advisory model discovery, the provider chain and tool settings
// around the shared @repo/chat-engine agent loop. The engine owns the loop itself (tools,
// citations, replay, routing between providers and strict research).
import {
  generateChatReplyStream as runChatEngine,
  type ChatMessage as EngineChatMessage,
  type ChatReply as EngineChatReply,
  type ChatReplyStreamChunk as EngineChatReplyStreamChunk,
  type ChatRole as EngineChatRole,
  type ChatToolActivity as EngineChatToolActivity,
  type ChatToolsConfig,
  type CoreChatToolName,
} from "@repo/chat-engine/chat";
import type { ResearchMode } from "@repo/chat-engine/research-policy";
import type { WebToolsConfig } from "../config";
import { buildProviderCandidates } from "./agent-provider";
import {
  GenerationUnavailableError,
  type FetchImplementation,
  type LlmFallbackLogger,
  type ProviderConfig,
} from "./llm-client";
import { discoverPrimaryModelAvailability } from "./provider-models";

// Provider warnings can contain raw upstream details. The gateway logs only allowlisted metadata.
globalThis.AI_SDK_LOG_WARNINGS = false;

// The HTTP request deadline (275 s by default) also covers validation and model discovery, so
// this deadline starts before discovery. The engine applies the same limit to the agent loop.
const GENERATION_TIMEOUT_MS = 260_000;

export type ChatRole = EngineChatRole;
export type ChatMessage = EngineChatMessage;
export type ChatToolName = CoreChatToolName;
export type ChatToolActivity = EngineChatToolActivity<ChatToolName>;
export type ChatReply = EngineChatReply<ChatToolName>;
export type ChatReplyStreamChunk = EngineChatReplyStreamChunk<ChatToolName>;

export type ChatGenerationOptions = {
  providerConfig: ProviderConfig;
  webTools?: WebToolsConfig;
  researchMode?: ResearchMode;
  signal?: AbortSignal;
  /** Per-step output cap. Unset leaves each provider's own limit, as the service always has. */
  maxOutputTokens?: number;
  /** Opt-in, and only exposed when discovery advertises the configured image model. */
  imageGeneration?: { enabled: boolean; model: string };
  firstChunkTimeoutMs?: number;
  dependencies?: {
    discoverModel?: typeof discoverPrimaryModelAvailability;
    logger?: LlmFallbackLogger;
    fetch?: FetchImplementation;
    now?: () => Date;
  };
};

/** Stream an agentic turn with tool progress and provider fallback between model steps. */
export async function* generateChatReplyStream(
  messages: readonly ChatMessage[],
  options: ChatGenerationOptions,
): AsyncGenerator<ChatReplyStreamChunk, void, void> {
  if (!messages.length) throw new Error("No chat messages were provided");
  const signal = AbortSignal.any([
    AbortSignal.timeout(GENERATION_TIMEOUT_MS),
    ...(options.signal ? [options.signal] : []),
  ]);
  signal.throwIfAborted();
  const logger = options.dependencies?.logger;
  const discover =
    options.dependencies?.discoverModel ?? discoverPrimaryModelAvailability;
  const discoveryOptions = {
    signal,
    ...(options.dependencies?.fetch
      ? { fetch: options.dependencies.fetch }
      : {}),
  };
  let providerConfig = options.providerConfig;
  const imagePrimary = options.providerConfig.primary;
  // Independent checks against the same endpoint: run them together so a slow /models is paid once.
  const [textAvailability, imageAvailability] = await Promise.all([
    providerConfig.primary
      ? discover(providerConfig.primary, discoveryOptions)
      : undefined,
    options.imageGeneration?.enabled && imagePrimary
      ? discover(
          { ...imagePrimary, model: options.imageGeneration.model },
          discoveryOptions,
        )
      : undefined,
  ]);
  if (providerConfig.primary && textAvailability === "unavailable") {
    logger?.warn("Configured primary model is not advertised", {
      event: "provider_model_unavailable",
      provider: "primary-openai-compatible",
      model: providerConfig.primary.model,
      errorClass: "ModelUnavailableError",
    });
    providerConfig = { ...providerConfig, primary: undefined };
  }
  signal.throwIfAborted();
  const providers = buildProviderCandidates(providerConfig, {
    fetch: options.dependencies?.fetch,
    firstChunkTimeoutMs: options.firstChunkTimeoutMs,
  });
  if (!providers.length) throw new GenerationUnavailableError([]);

  // Research tools are always offered unless the caller chose research "never"; a search
  // provider that is not configured reports its own error to the model.
  const webTools = options.webTools ?? {};
  const tools: ChatToolsConfig = {
    webSearch: webTools,
    urlReader: {
      firecrawlApiKey: webTools.firecrawlApiKey,
      jinaApiKey: webTools.jinaApiKey,
    },
    httpFetch: {
      userAgent: `SignLoop/1.0 (+${options.providerConfig.publicServiceUrl || "http://localhost:3000"})`,
    },
    ...(imageAvailability === "available" && imagePrimary
      ? {
          imageGeneration: {
            baseURL: imagePrimary.baseURL,
            apiKey: imagePrimary.apiKey,
            model: options.imageGeneration!.model,
            referer: options.providerConfig.publicServiceUrl,
            appName: options.providerConfig.appName,
          },
        }
      : {}),
  };

  yield* runChatEngine<ChatToolName>(messages, {
    providers,
    signal,
    // No service cap: each provider's own output limit applies, which leaves room for thinking.
    maxOutputTokens: options.maxOutputTokens ?? null,
    firstChunkTimeoutMs: options.firstChunkTimeoutMs,
    tools,
    researchMode: options.researchMode ?? "auto",
    onProviderFailure: (failure) =>
      logger?.warn("Chat provider step failed", {
        event: "provider_failure",
        ...failure,
      }),
    createExhaustedError: (failures) => new GenerationUnavailableError(failures),
    now: options.dependencies?.now,
    // The HTTP boundary owns safe error reporting; the SDK default would log raw upstream errors.
    onStreamError: () => {},
    // A deadline's TimeoutError must reach the handler, which maps it to request_timeout.
    rethrowAbortReason: true,
  });
}

/** Collect the streaming agent's canonical final reply for non-streaming callers. */
export async function generateChatReply(
  messages: readonly ChatMessage[],
  options: ChatGenerationOptions,
): Promise<ChatReply> {
  for await (const chunk of generateChatReplyStream(messages, options)) {
    if (chunk.type === "done") return chunk.reply;
  }
  throw new Error("Chat did not complete");
}
