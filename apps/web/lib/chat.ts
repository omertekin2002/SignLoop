import {
  generateChatReplyStream as generateEngineReplyStream,
  type ChatMessage,
  type ChatReply as EngineChatReply,
  type ChatReplyStreamChunk as EngineChatReplyStreamChunk,
  type ChatToolActivity as EngineChatToolActivity,
  type CoreChatToolName,
} from "@repo/chat-engine/chat";
import { resolvePrimaryModel } from "@/lib/llm-client";
import { chatTelemetryOptions } from "@/lib/telemetry-policy";
import type { GenerationMilestone } from "@/lib/generation-timings";
import {
  chatProviderCandidates,
  httpFetchConfig,
  imageGenerationConfig,
  urlReaderConfig,
  webSearchConfig,
} from "@/lib/chat-engine-config";
import {
  contractToolExtension,
  type ContractToolName,
} from "@/lib/contract-tools";

// SignLoop's binding of the shared chat engine (@repo/chat-engine): provider routing, tool
// settings, and telemetry come from this deployment's configuration, and the user's contracts are
// added through the contract-tool extension.

export { CHAT_MAX_OUTPUT_TOKENS } from "@repo/chat-engine/chat";
export type { ChatMessage, ChatRole } from "@repo/chat-engine/chat";
export type ChatToolName = CoreChatToolName | ContractToolName;
export type ChatToolActivity = EngineChatToolActivity<ChatToolName>;
export type ChatReply = EngineChatReply<ChatToolName>;
export type ChatReplyStreamChunk = EngineChatReplyStreamChunk<ChatToolName>;

type ChatGenerationOptions = {
  primaryModel?: string | null;
  signal?: AbortSignal;
  maxOutputTokens?: number;
  enableWebSearch?: boolean;
  enableUrlReader?: boolean;
  /** Enables http_get: direct GETs to any public address, returned as raw response bodies. */
  enableHttpFetch?: boolean;
  /** Enables list_contracts and read_contract scoped to this user's own documents. */
  contractsUserId?: string | null;
  /** Enables generate_image; the route sets this from the live model availability snapshot. */
  enableImageGeneration?: boolean;
  /** Passed through to the image endpoint's `user` field for abuse attribution. */
  userId?: string | null;
  firstChunkTimeoutMs?: number;
  /** Temporary chat disables AI tracing even when the deployment opts into content recording. */
  recordTelemetry?: boolean;
  /** Content-free lifecycle hooks; no per-token telemetry. */
  onTiming?: (event: GenerationMilestone) => void;
};

export async function* generateChatReplyStream(
  messages: readonly ChatMessage[],
  options?: ChatGenerationOptions,
): AsyncGenerator<ChatReplyStreamChunk, void, void> {
  yield* generateEngineReplyStream<ChatToolName>(messages, {
    providers: chatProviderCandidates(
      resolvePrimaryModel(options?.primaryModel),
    ),
    signal: options?.signal,
    maxOutputTokens: options?.maxOutputTokens,
    firstChunkTimeoutMs: options?.firstChunkTimeoutMs,
    onTiming: options?.onTiming,
    telemetry: chatTelemetryOptions(options?.recordTelemetry !== false),
    tools: {
      ...(options?.enableWebSearch ? { webSearch: webSearchConfig() } : {}),
      ...(options?.enableUrlReader ? { urlReader: urlReaderConfig() } : {}),
      ...(options?.enableHttpFetch ? { httpFetch: httpFetchConfig() } : {}),
      extensions: [contractToolExtension(options?.contractsUserId)],
      ...(options?.enableImageGeneration
        ? {
            imageGeneration: {
              ...imageGenerationConfig(),
              userId: options.userId,
            },
          }
        : {}),
    },
  });
}

export async function generateChatReply(
  messages: readonly ChatMessage[],
  options?: ChatGenerationOptions,
): Promise<ChatReply> {
  for await (const chunk of generateChatReplyStream(messages, options)) {
    if (chunk.type === "done") return chunk.reply;
  }
  throw new Error("Chat did not complete");
}
