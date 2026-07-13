import OpenAI from "openai";
import {
  APP_NAME,
  OPENROUTER_API_KEY,
  OPENROUTER_BASE_URL,
  OPENROUTER_MODELS,
  PRIMARY_LLM_API_KEY,
  PRIMARY_LLM_BASE_URL,
  SITE_URL,
  createOpenAiCompatibleClient,
  extractResponseOutputText,
  resolvePrimaryModel,
  runWithPrimaryAndOpenRouterFallback,
} from "@/lib/llm-client";
import {
  prepareMessagesWithGeminiWebSearch,
  type WebSearchMetadata,
} from "@/lib/gemini-search";
import { getErrorMessage, isRecord } from "@/lib/utils";

const MAX_CHAT_OUTPUT_TOKENS = 4_096;

export type ChatRole = "system" | "user" | "assistant";

export type ChatMessage = {
  role: ChatRole;
  content: string;
};

export type ChatReply = {
  message: string;
  provider: "primary-openai-compatible" | "openrouter";
  model: string;
  webSearch: WebSearchMetadata | null;
};

export type ChatReplyStreamChunk =
  | {
      type: "delta";
      text: string;
    }
  | {
      type: "done";
      reply: ChatReply;
    };

// The fetch-based OpenRouter streamer never touches the SDK, so define this structurally rather
// than importing OpenAI.RequestOptions just for one field. (Stays compatible with the SDK shape.)
type ChatRequestOptions = { signal?: AbortSignal | null };

type ChatGenerationOptions = {
  primaryModel?: string | null;
  signal?: AbortSignal;
  enableWebSearch?: boolean;
};

function toResponseInput(messages: readonly ChatMessage[]) {
  return messages.map((message) => ({
    role: message.role,
    content: message.content,
  }));
}

function extractResponseFailureMessage(
  response: OpenAI.Responses.Response,
): string | null {
  const error = response.error;
  if (error?.message) {
    return error.message;
  }

  if (response.status === "incomplete" && response.incomplete_details?.reason) {
    return `Incomplete response: ${response.incomplete_details.reason}`;
  }

  if (response.status === "failed") {
    return "AI response failed";
  }

  return null;
}

function getOpenRouterResponsesUrl(): string {
  return `${OPENROUTER_BASE_URL.replace(/\/+$/, "")}/responses`;
}

function parseJsonRecord(value: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function extractOpenRouterErrorMessage(status: number, body: string): string {
  const payload = parseJsonRecord(body);
  const error = isRecord(payload?.error) ? payload.error : null;
  const message =
    typeof error?.message === "string"
      ? error.message
      : typeof payload?.message === "string"
        ? payload.message
        : body.trim();

  return `${status} ${message || "OpenRouter request failed"}`.slice(0, 1200);
}

function extractSseDataPayload(block: string): string | null {
  const dataLines: string[] = [];

  for (const line of block.split("\n")) {
    if (!line || line.startsWith(":")) {
      continue;
    }

    const separatorIndex = line.indexOf(":");
    const field = separatorIndex >= 0 ? line.slice(0, separatorIndex) : line;
    const rawValue = separatorIndex >= 0 ? line.slice(separatorIndex + 1) : "";
    const value = rawValue.startsWith(" ") ? rawValue.slice(1) : rawValue;

    if (field === "data") {
      dataLines.push(value);
    }
  }

  return dataLines.length ? dataLines.join("\n") : null;
}

async function* readSseDataPayloads(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<string, void, void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (value) {
      buffer += decoder.decode(value, { stream: !done });
      buffer = buffer.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    }
    if (done) {
      buffer += decoder.decode();
      buffer = buffer.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    }

    let separatorIndex = buffer.indexOf("\n\n");
    while (separatorIndex >= 0) {
      const block = buffer.slice(0, separatorIndex);
      buffer = buffer.slice(separatorIndex + 2);

      const payload = extractSseDataPayload(block);
      if (payload) {
        yield payload;
      }

      separatorIndex = buffer.indexOf("\n\n");
    }

    if (done) {
      const trailingPayload = extractSseDataPayload(buffer);
      if (trailingPayload) {
        yield trailingPayload;
      }
      return;
    }
  }
}

// Resolve the final assistant text from a finished Responses stream, preferring the fully-formed
// completed response, then the finalized output-text event, then the concatenated deltas. Shared by
// both streaming readers (SDK iterator + raw OpenRouter SSE) so the fallback order can't drift.
function resolveStreamedContent(input: {
  completedResponse: OpenAI.Responses.Response | null;
  finalizedText: string | null;
  chunks: string[];
}): string {
  const completedText = input.completedResponse
    ? extractResponseOutputText(input.completedResponse)
    : null;
  const finalizedOutputText = input.finalizedText?.trim();
  const streamedText = input.chunks.join("").trim();
  const content =
    completedText ?? (finalizedOutputText || null) ?? streamedText;
  if (!content) {
    throw new Error("Empty response from AI");
  }

  return content;
}

async function runChatWithResponsesModel(
  openai: OpenAI,
  model: string,
  messages: readonly ChatMessage[],
  options?: ChatRequestOptions,
): Promise<string> {
  const response = await openai.responses.create(
    {
      model,
      input: toResponseInput(messages),
      max_output_tokens: MAX_CHAT_OUTPUT_TOKENS,
    },
    options,
  );

  const content = extractResponseOutputText(response);
  if (!content) {
    throw new Error("Empty response from AI");
  }

  return content;
}

async function* runOpenRouterResponsesModelStream(
  model: string,
  messages: readonly ChatMessage[],
  options?: ChatRequestOptions,
  onDelta?: () => void,
): AsyncGenerator<ChatReplyStreamChunk, string, void> {
  if (!OPENROUTER_API_KEY) {
    throw new Error("OpenRouter fallback is not configured");
  }

  const response = await fetch(getOpenRouterResponsesUrl(), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
      "HTTP-Referer": SITE_URL,
      "X-Title": APP_NAME,
    },
    body: JSON.stringify({
      model,
      input: toResponseInput(messages),
      max_output_tokens: MAX_CHAT_OUTPUT_TOKENS,
      stream: true,
    }),
    signal: options?.signal,
  });

  if (!response.ok) {
    throw new Error(
      extractOpenRouterErrorMessage(response.status, await response.text()),
    );
  }

  if (!response.body) {
    throw new Error("OpenRouter response stream was empty");
  }

  const chunks: string[] = [];
  let completedResponse: OpenAI.Responses.Response | null = null;
  let finalizedText: string | null = null;

  for await (const payload of readSseDataPayloads(response.body)) {
    if (payload === "[DONE]") {
      break;
    }

    const event = parseJsonRecord(payload);
    if (!event) {
      continue;
    }

    const eventType = typeof event.type === "string" ? event.type : "";

    if (eventType === "response.keep_alive") {
      continue;
    }

    if (eventType === "response.output_text.delta") {
      const delta = typeof event.delta === "string" ? event.delta : "";
      if (delta) {
        chunks.push(delta);
        onDelta?.();
        yield { type: "delta", text: delta };
      }
      continue;
    }

    if (eventType === "response.output_text.done") {
      finalizedText = typeof event.text === "string" ? event.text : null;
      continue;
    }

    if (eventType === "response.completed") {
      if (isRecord(event.response)) {
        completedResponse =
          event.response as unknown as OpenAI.Responses.Response;
      }
      continue;
    }

    if (
      eventType === "response.failed" ||
      eventType === "response.incomplete"
    ) {
      const failedResponse = isRecord(event.response)
        ? (event.response as unknown as OpenAI.Responses.Response)
        : null;
      throw new Error(
        failedResponse
          ? (extractResponseFailureMessage(failedResponse) ??
              "AI response failed")
          : "AI response failed",
      );
    }

    if (eventType === "error") {
      const error = isRecord(event.error) ? event.error : null;
      const message =
        typeof event.message === "string"
          ? event.message
          : typeof error?.message === "string"
            ? error.message
            : "AI response stream failed";
      throw new Error(message);
    }
  }

  return resolveStreamedContent({ completedResponse, finalizedText, chunks });
}

async function prepareChatMessages(
  messages: readonly ChatMessage[],
  options?: Pick<ChatGenerationOptions, "enableWebSearch" | "signal">,
): Promise<{
  messages: readonly ChatMessage[];
  webSearch: WebSearchMetadata | null;
}> {
  if (!options?.enableWebSearch) {
    return { messages, webSearch: null };
  }

  const prepared = await prepareMessagesWithGeminiWebSearch(messages, {
    signal: options.signal,
  });
  return {
    messages: prepared.messages,
    webSearch: prepared.webSearch,
  };
}

export async function generateChatReply(
  messages: readonly ChatMessage[],
  options?: ChatGenerationOptions,
): Promise<ChatReply> {
  if (!messages.length) {
    throw new Error("No chat messages were provided");
  }

  const selectedPrimaryModel = resolvePrimaryModel(options?.primaryModel);
  const prepared = await prepareChatMessages(messages, options);

  const { result, provider, model } = await runWithPrimaryAndOpenRouterFallback(
    selectedPrimaryModel,
    (client, runModel) =>
      runChatWithResponsesModel(client, runModel, prepared.messages, {
        signal: options?.signal,
      }),
    { signal: options?.signal },
  );

  return {
    message: result,
    provider,
    model,
    webSearch: prepared.webSearch,
  };
}

async function* runPrimaryResponsesModelStream(
  openai: OpenAI,
  model: string,
  messages: readonly ChatMessage[],
  options?: ChatRequestOptions,
  onDelta?: () => void,
): AsyncGenerator<ChatReplyStreamChunk, string, void> {
  const stream = await openai.responses.create(
    {
      model,
      input: toResponseInput(messages),
      max_output_tokens: MAX_CHAT_OUTPUT_TOKENS,
      stream: true,
    },
    options,
  );

  const chunks: string[] = [];
  let completedResponse: OpenAI.Responses.Response | null = null;
  let finalizedText: string | null = null;

  for await (const event of stream) {
    if (event.type === "response.output_text.delta") {
      const delta = typeof event.delta === "string" ? event.delta : "";
      if (delta) {
        chunks.push(delta);
        onDelta?.();
        yield { type: "delta", text: delta };
      }
      continue;
    }

    if (event.type === "response.output_text.done") {
      finalizedText = typeof event.text === "string" ? event.text : null;
      continue;
    }

    if (event.type === "response.completed") {
      completedResponse = event.response;
      continue;
    }

    if (
      event.type === "response.failed" ||
      event.type === "response.incomplete"
    ) {
      throw new Error(
        extractResponseFailureMessage(event.response) ?? "AI response failed",
      );
    }

    if (event.type === "error") {
      const message =
        typeof event.message === "string"
          ? event.message
          : "AI response stream failed";
      throw new Error(message);
    }
  }

  return resolveStreamedContent({ completedResponse, finalizedText, chunks });
}

export async function* generateChatReplyStream(
  messages: readonly ChatMessage[],
  options?: ChatGenerationOptions,
): AsyncGenerator<ChatReplyStreamChunk, void, void> {
  if (!messages.length) {
    throw new Error("No chat messages were provided");
  }

  const selectedPrimaryModel = resolvePrimaryModel(options?.primaryModel);
  // Search before entering the provider fallback loop so one grounded result is reused by every
  // model attempt. A search failure therefore cannot silently degrade into an unsearched answer.
  const prepared = await prepareChatMessages(messages, options);

  let primaryEmittedContent = false;

  try {
    const primaryClient = createOpenAiCompatibleClient(
      PRIMARY_LLM_BASE_URL,
      PRIMARY_LLM_API_KEY,
    );

    const message = yield* runPrimaryResponsesModelStream(
      primaryClient,
      selectedPrimaryModel,
      prepared.messages,
      { signal: options?.signal },
      () => {
        primaryEmittedContent = true;
      },
    );

    yield {
      type: "done",
      reply: {
        message,
        provider: "primary-openai-compatible",
        model: selectedPrimaryModel,
        webSearch: prepared.webSearch,
      },
    };
    return;
  } catch (primaryError) {
    if (options?.signal?.aborted) {
      throw primaryError;
    }

    const primaryErrorMessage = getErrorMessage(primaryError);

    // If the primary stream already emitted tokens, restarting on a fallback model would
    // duplicate visible content, so surface a hard error instead of falling through.
    if (primaryEmittedContent) {
      throw new Error(
        `Primary chat stream failed after response started: ${primaryErrorMessage}`,
      );
    }

    console.warn(
      "Primary chat model failed, falling back to streaming OpenRouter",
      {
        baseURL: PRIMARY_LLM_BASE_URL,
        model: selectedPrimaryModel,
        error: primaryErrorMessage,
      },
    );

    if (!OPENROUTER_API_KEY) {
      throw new Error(
        `Primary chat model failed and OpenRouter fallback is not configured. Primary error: ${primaryErrorMessage}`,
      );
    }

    const fallbackModels = OPENROUTER_MODELS;
    const fallbackFailures: string[] = [];

    for (const fallbackModel of fallbackModels) {
      let emittedFallbackContent = false;

      try {
        const message = yield* runOpenRouterResponsesModelStream(
          fallbackModel,
          prepared.messages,
          { signal: options?.signal },
          () => {
            emittedFallbackContent = true;
          },
        );

        if (fallbackModel !== fallbackModels[0]) {
          console.warn(
            "OpenRouter chat fallback model succeeded after earlier model failed",
            {
              firstFallbackModel: fallbackModels[0],
              successfulFallbackModel: fallbackModel,
            },
          );
        }

        yield {
          type: "done",
          reply: {
            message,
            provider: "openrouter",
            model: fallbackModel,
            webSearch: prepared.webSearch,
          },
        };
        return;
      } catch (fallbackError) {
        if (options?.signal?.aborted) {
          throw fallbackError;
        }

        const fallbackErrorMessage = getErrorMessage(fallbackError);

        if (emittedFallbackContent) {
          throw new Error(
            `OpenRouter chat stream failed after response started: ${fallbackErrorMessage}`,
          );
        }

        fallbackFailures.push(`${fallbackModel}: ${fallbackErrorMessage}`);
        console.warn(
          "OpenRouter chat fallback model failed before streaming content",
          {
            model: fallbackModel,
            error: fallbackErrorMessage,
          },
        );
      }
    }

    throw new Error(
      `Primary chat model failed (${primaryErrorMessage}) and OpenRouter fallback failed (${fallbackFailures.join(
        " | ",
      )})`,
    );
  }
}
