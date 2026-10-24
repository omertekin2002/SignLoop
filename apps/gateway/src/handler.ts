// HTTP behavior adapted from SignLoop apps/web/app/api/chat/route.ts.
// Source commit: 5d06ed2630386c4a9af78373ce998d31dbc1f776

import { randomUUID } from "node:crypto";

import { InferenceSemaphore, type ReleaseSlot } from "./concurrency";
import { getServiceConfig, type ServiceConfig } from "./config";
import {
  generateChatReply,
  generateChatReplyStream,
  type ChatMessage,
  type ChatReply,
  type ChatReplyStreamChunk,
} from "./pipeline/chat";
import {
  MAX_CHAT_REQUEST_BODY_BYTES,
  parseBoundedJsonRequest,
  parseClientChatMessages,
} from "./pipeline/chat-policy";
import {
  GenerationUnavailableError,
  type ProviderConfig,
} from "./pipeline/llm-client";
import {
  parseResearchMode,
  ResearchUnavailableError,
  type ResearchMode,
} from "./pipeline/research-policy";
import { appendWebSourcesToMessage } from "./pipeline/web-citations";
import { DEFAULT_CHAT_ERROR_MESSAGE } from "./prompts";
import { isRecord } from "./utils";

const SERVICE_NAME = "signloop-chat-service";
const STREAM_CONTENT_TYPE = "application/x-ndjson; charset=utf-8";
const JSON_CONTENT_TYPE = "application/json; charset=utf-8";
const STREAM_ENDED_ERROR = "Chat stream ended before completion.";
const TIMEOUT_ERROR = "Chat request timed out. Please try again.";

export type PipelineRequestOptions = Readonly<{
  signal: AbortSignal;
  requestId: string;
  researchMode: ResearchMode;
}>;

export type ChatPipeline = Readonly<{
  generate: (
    messages: readonly ChatMessage[],
    options: PipelineRequestOptions,
  ) => Promise<ChatReply>;
  stream: (
    messages: readonly ChatMessage[],
    options: PipelineRequestOptions,
  ) => AsyncIterable<ChatReplyStreamChunk>;
}>;

export type StructuredLogEntry = Readonly<Record<string, unknown>>;
export type StructuredLogSink = (entry: StructuredLogEntry) => void;

export type RequestHandlerOptions = Readonly<{
  config: ServiceConfig;
  pipeline?: ChatPipeline;
  semaphore?: InferenceSemaphore;
  log?: StructuredLogSink;
  requestIdFactory?: () => string;
}>;

type RequestLogContext = {
  requestId: string;
  route: string;
  startedAt: number;
  streaming?: boolean;
  messageCount?: number;
  totalMessageCharacters?: number;
};

type ExecutionScope = {
  readonly signal: AbortSignal;
  readonly timedOut: boolean;
  readonly cancelled: boolean;
  cancel(reason?: unknown): void;
  cleanup(): void;
};

function defaultLog(entry: StructuredLogEntry): void {
  console.log(JSON.stringify(entry));
}

function safeErrorClass(error: unknown): string {
  const candidate =
    error instanceof Error
      ? error.name || error.constructor.name
      : typeof error;
  return /^[A-Za-z0-9_.-]{1,100}$/.test(candidate) ? candidate : "Error";
}

function normalizeRequestId(value: string | null): string | null {
  const trimmed = value?.trim() ?? "";
  return /^[A-Za-z0-9._:-]{1,128}$/.test(trimmed) ? trimmed : null;
}

function requestPath(request: Request): string {
  try {
    return new URL(request.url).pathname;
  } catch {
    return "/";
  }
}

function createExecutionScope(
  requestSignal: AbortSignal,
  timeoutMs: number,
): ExecutionScope {
  const controller = new AbortController();
  let timedOut = false;
  let cancelled = false;

  const onRequestAbort = () => {
    cancelled = true;
    controller.abort(requestSignal.reason);
  };

  if (requestSignal.aborted) {
    onRequestAbort();
  } else {
    requestSignal.addEventListener("abort", onRequestAbort, { once: true });
  }

  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort(
      new DOMException("Service request timed out", "TimeoutError"),
    );
  }, timeoutMs);

  return {
    get signal() {
      return controller.signal;
    },
    get timedOut() {
      return timedOut;
    },
    get cancelled() {
      return cancelled;
    },
    cancel(reason?: unknown) {
      cancelled = true;
      controller.abort(reason);
    },
    cleanup() {
      clearTimeout(timeout);
      requestSignal.removeEventListener("abort", onRequestAbort);
    },
  };
}

function abortError(signal: AbortSignal): unknown {
  return (
    signal.reason ?? new DOMException("The operation was aborted", "AbortError")
  );
}

/** Stop awaiting promptly even if an injected/upstream operation is slow to observe its signal. */
function waitWithAbort<T>(
  operation: PromiseLike<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError(signal));

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = () => finish(() => reject(abortError(signal)));
    signal.addEventListener("abort", onAbort, { once: true });

    Promise.resolve(operation).then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}

export function toProviderConfig(config: ServiceConfig): ProviderConfig {
  return {
    ...(config.geminiChat
      ? {
          gemini: {
            apiKey: config.geminiChat.apiKey,
            model: config.geminiChat.model,
          },
        }
      : {}),
    ...(config.primaryLlm
      ? {
          primary: {
            baseURL: config.primaryLlm.baseUrl,
            apiKey: config.primaryLlm.apiKey,
            model: config.primaryLlm.model,
          },
        }
      : {}),
    ...(config.openRouter
      ? {
          openRouter: {
            baseURL: config.openRouter.baseUrl,
            apiKey: config.openRouter.apiKey,
            models: config.openRouter.models,
          },
        }
      : {}),
    publicServiceUrl: config.publicServiceUrl,
    appName: config.appName,
  };
}

function createConfiguredPipeline(
  config: ServiceConfig,
  log: StructuredLogSink,
): ChatPipeline {
  const providerConfig = toProviderConfig(config);
  const optionsFor = (options: PipelineRequestOptions) => ({
    providerConfig,
    webTools: config.webTools,
    imageGeneration: {
      enabled: config.imageGenerationEnabled,
      model: config.imageGenerationModel,
    },
    signal: options.signal,
    researchMode: options.researchMode,
    dependencies: {
      // Pipeline warnings contain only fixed event text and whitelisted model metadata. Upstream
      // bodies, URLs, credentials, and prompts are deliberately discarded at this boundary.
      logger: {
        warn(_message: unknown, details?: unknown) {
          const metadata = isRecord(details) ? details : {};
          const safeString = (value: unknown, maximum = 200) =>
            typeof value === "string" &&
            value.length <= maximum &&
            /^[A-Za-z0-9_.:/-]+$/u.test(value)
              ? value
              : undefined;
          const safeEvent = [
            "provider_failure",
            "provider_model_unavailable",
            "provider_fallback_succeeded",
            "research_fallback",
          ].includes(String(metadata.event))
            ? String(metadata.event)
            : "provider_fallback";
          const statusCode =
            typeof metadata.statusCode === "number" &&
            Number.isInteger(metadata.statusCode) &&
            metadata.statusCode >= 100 &&
            metadata.statusCode <= 599
              ? metadata.statusCode
              : undefined;
          log({
            level: "warn",
            event: safeEvent,
            requestId: options.requestId,
            ...(safeString(metadata.provider)
              ? { provider: metadata.provider }
              : {}),
            ...(safeString(metadata.model) ? { model: metadata.model } : {}),
            ...(safeString(metadata.errorClass, 100)
              ? { errorClass: metadata.errorClass }
              : {}),
            ...(statusCode !== undefined ? { statusCode } : {}),
            ...(safeString(metadata.providerCode, 100)
              ? { providerCode: metadata.providerCode }
              : {}),
            ...(safeString(metadata.upstreamRequestId, 128)
              ? { upstreamRequestId: metadata.upstreamRequestId }
              : {}),
            ...(safeString(metadata.firstFallbackModel)
              ? { firstFallbackModel: metadata.firstFallbackModel }
              : {}),
            ...(safeString(metadata.successfulFallbackModel)
              ? { successfulFallbackModel: metadata.successfulFallbackModel }
              : {}),
          });
        },
      },
    },
  });

  return {
    generate: (messages, options) =>
      generateChatReply(messages, optionsFor(options)),
    stream: (messages, options) =>
      generateChatReplyStream(messages, optionsFor(options)),
  };
}

function corsHeaders(
  request: Request,
  config: ServiceConfig,
): Record<string, string> {
  const origin = request.headers.get("origin");
  if (!origin || !config.corsAllowedOrigins.has(origin)) return {};

  return {
    "Access-Control-Allow-Origin": origin,
    Vary: "Origin",
  };
}

function responseHeaders(
  request: Request,
  config: ServiceConfig,
  requestId: string,
  contentType = JSON_CONTENT_TYPE,
): Headers {
  return new Headers({
    "Content-Type": contentType,
    "Cache-Control": "no-store",
    "X-Request-ID": requestId,
    ...corsHeaders(request, config),
  });
}

function jsonResponse(
  request: Request,
  config: ServiceConfig,
  requestId: string,
  body: unknown,
  status: number,
  extraHeaders?: Readonly<Record<string, string>>,
): Response {
  const headers = responseHeaders(request, config, requestId);
  for (const [name, value] of Object.entries(extraHeaders ?? {})) {
    headers.set(name, value);
  }
  return new Response(JSON.stringify(body), { status, headers });
}

function ndjsonEvent(event: Record<string, unknown>): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(event)}\n`);
}

function canonicalMessage(reply: ChatReply): string {
  return appendWebSourcesToMessage(
    reply.message,
    reply.webSearch?.sources ?? [],
    { readThisTurn: reply.readSources, figures: reply.figures },
  );
}

function replyMetadata(reply: ChatReply): Record<string, unknown> {
  return {
    provider: reply.provider,
    model: reply.model,
    webSearch: reply.webSearch,
    webSearchQuery: reply.webSearch?.query ?? null,
    webSearchAttempts: reply.webSearch?.attemptedQueries ?? [],
    webSearchSuccessfulCount: reply.webSearch?.successfulSearches ?? 0,
    webSources: reply.webSearch?.sources ?? [],
    agentMessages: reply.agentMessages,
    toolActivity: reply.toolActivity ?? [],
    readSources: reply.readSources ?? [],
    figures: reply.figures,
  };
}

function publicPipelineError(
  error: unknown,
  scope: ExecutionScope,
): {
  status: 502 | 504;
  message: string;
  code: "research_unavailable" | "generation_unavailable" | "request_timeout";
} {
  if (
    scope.timedOut ||
    (error instanceof Error && error.name === "TimeoutError")
  ) {
    return { status: 504, message: TIMEOUT_ERROR, code: "request_timeout" };
  }
  // Search failures are returned to the model as tool errors; only the strict-research check
  // itself reaches this boundary.
  if (error instanceof ResearchUnavailableError) {
    return {
      status: 502,
      message: "Grounded research is temporarily unavailable.",
      code: "research_unavailable",
    };
  }
  if (error instanceof GenerationUnavailableError) {
    return {
      status: 502,
      message: DEFAULT_CHAT_ERROR_MESSAGE,
      code: "generation_unavailable",
    };
  }
  return {
    status: 502,
    message: DEFAULT_CHAT_ERROR_MESSAGE,
    code: "generation_unavailable",
  };
}

function isJsonContentType(request: Request): boolean {
  return (
    request.headers
      .get("content-type")
      ?.split(";", 1)[0]
      ?.trim()
      .toLowerCase() === "application/json"
  );
}

function declaredBodyTooLarge(request: Request): boolean {
  const raw = request.headers.get("content-length");
  if (!raw || !/^\d+$/.test(raw.trim())) return false;
  const length = Number(raw);
  return Number.isFinite(length) && length > MAX_CHAT_REQUEST_BODY_BYTES;
}

function parseStreaming(body: Record<string, unknown>): boolean | null {
  if (body.stream === undefined) return true;
  return typeof body.stream === "boolean" ? body.stream : null;
}

function hasClientProviderSelection(body: Record<string, unknown>): boolean {
  return ["model", "primaryModel", "provider", "providerUrl", "baseURL"].some(
    (key) => Object.prototype.hasOwnProperty.call(body, key),
  );
}

export function createRequestHandler(
  options: RequestHandlerOptions,
): (request: Request) => Promise<Response> {
  const { config } = options;
  const semaphore =
    options.semaphore ?? new InferenceSemaphore(config.maxConcurrentRequests);
  const configuredLog = options.log ?? defaultLog;
  const log: StructuredLogSink = (entry) => {
    try {
      configuredLog(entry);
    } catch {
      // Logging must never change an HTTP result or retain an inference slot.
    }
  };
  const pipeline = options.pipeline ?? createConfiguredPipeline(config, log);
  const requestIdFactory = options.requestIdFactory ?? randomUUID;

  return async function requestHandler(request: Request): Promise<Response> {
    const path = requestPath(request);
    const requestId =
      normalizeRequestId(request.headers.get("x-request-id")) ??
      requestIdFactory();
    const context: RequestLogContext = {
      requestId,
      route: path,
      startedAt: Date.now(),
    };
    let logged = false;

    const finishLog = (
      status: number,
      extra: Record<string, unknown> = {},
    ): void => {
      if (logged) return;
      logged = true;
      log({
        requestId: context.requestId,
        route: context.route,
        status,
        durationMs: Math.max(0, Date.now() - context.startedAt),
        ...(context.streaming !== undefined
          ? { streaming: context.streaming }
          : {}),
        ...(context.messageCount !== undefined
          ? { messageCount: context.messageCount }
          : {}),
        ...(context.totalMessageCharacters !== undefined
          ? { totalMessageCharacters: context.totalMessageCharacters }
          : {}),
        ...extra,
      });
    };

    const respond = (
      body: unknown,
      status: number,
      extraHeaders?: Readonly<Record<string, string>>,
      logExtra?: Record<string, unknown>,
    ): Response => {
      finishLog(status, logExtra);
      return jsonResponse(
        request,
        config,
        requestId,
        body,
        status,
        extraHeaders,
      );
    };

    const respondError = (
      error: string,
      code:
        | "invalid_request"
        | "research_unavailable"
        | "generation_unavailable"
        | "request_timeout"
        | "service_busy",
      status: number,
      extraHeaders?: Readonly<Record<string, string>>,
      logExtra?: Record<string, unknown>,
    ): Response => respond({ error, code }, status, extraHeaders, logExtra);

    if (request.method === "GET" && path === "/healthz") {
      return respond({ ok: true, service: SERVICE_NAME }, 200);
    }

    if (request.method === "OPTIONS" && path === "/v1/chat") {
      const origin = request.headers.get("origin");
      if (!origin || !config.corsAllowedOrigins.has(origin)) {
        return respondError("Not found", "invalid_request", 404);
      }

      const headers = responseHeaders(request, config, requestId);
      headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
      headers.set("Access-Control-Allow-Headers", "Content-Type, X-Request-ID");
      headers.set("Access-Control-Max-Age", "600");
      finishLog(204);
      return new Response(null, { status: 204, headers });
    }

    if (request.method !== "POST" || path !== "/v1/chat") {
      return respondError("Not found", "invalid_request", 404);
    }

    const release = semaphore.tryAcquire();
    if (!release) {
      return respondError(
        "Too many concurrent chat requests. Please retry shortly.",
        "service_busy",
        429,
        { "Retry-After": "1" },
        { errorClass: "ConcurrencyLimitError" },
      );
    }

    const scope = createExecutionScope(request.signal, config.requestTimeoutMs);
    let streamOwnsResources = false;

    try {
      if (!isJsonContentType(request)) {
        return respondError(
          "Content-Type must be application/json.",
          "invalid_request",
          415,
        );
      }

      if (declaredBodyTooLarge(request)) {
        return respondError(
          "Chat request body is too large.",
          "invalid_request",
          413,
        );
      }

      const parsedBody = await parseBoundedJsonRequest<unknown>(
        request,
        MAX_CHAT_REQUEST_BODY_BYTES,
        scope.signal,
      );
      if (scope.timedOut) {
        return respondError(TIMEOUT_ERROR, "request_timeout", 504, undefined, {
          errorClass: "TimeoutError",
        });
      }
      if (!parsedBody.ok) {
        return respondError(
          parsedBody.error,
          "invalid_request",
          parsedBody.status,
        );
      }

      const parsedMessages = parseClientChatMessages(parsedBody.value);
      if (!parsedMessages.ok) {
        return respondError(
          parsedMessages.error,
          "invalid_request",
          parsedMessages.status,
        );
      }
      if (!isRecord(parsedBody.value)) {
        return respondError(
          "Request body must be an object.",
          "invalid_request",
          400,
        );
      }
      const body = parsedBody.value;
      if (hasClientProviderSelection(body)) {
        return respondError(
          "The model and provider are controlled by the service.",
          "invalid_request",
          400,
        );
      }

      const streaming = parseStreaming(body);
      if (streaming === null) {
        return respondError(
          "stream must be a boolean.",
          "invalid_request",
          400,
        );
      }
      const researchMode = parseResearchMode(body.research);
      if (researchMode === null) {
        return respondError(
          "research must be one of: auto, always, never.",
          "invalid_request",
          400,
        );
      }

      context.streaming = streaming;
      context.messageCount = parsedMessages.messages.length;
      context.totalMessageCharacters = parsedMessages.messages.reduce(
        (total, message) => total + message.content.length,
        0,
      );

      const pipelineOptions: PipelineRequestOptions = {
        signal: scope.signal,
        requestId,
        researchMode,
      };

      if (!streaming) {
        let reply: ChatReply;
        try {
          reply = await waitWithAbort(
            pipeline.generate(parsedMessages.messages, pipelineOptions),
            scope.signal,
          );
        } catch (error) {
          const publicError = publicPipelineError(error, scope);
          return respondError(
            publicError.message,
            publicError.code,
            publicError.status,
            undefined,
            { errorClass: safeErrorClass(error) },
          );
        }
        if (scope.timedOut) {
          return respondError(
            TIMEOUT_ERROR,
            "request_timeout",
            504,
            undefined,
            { errorClass: "TimeoutError" },
          );
        }

        const message = canonicalMessage(reply);
        return respond({ message, ...replyMetadata(reply) }, 200, undefined, {
          provider: reply.provider,
          model: reply.model,
        });
      }

      const headers = responseHeaders(
        request,
        config,
        requestId,
        STREAM_CONTENT_TYPE,
      );
      headers.set("Cache-Control", "no-cache, no-transform");
      headers.set("X-Accel-Buffering", "no");

      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          let terminalEventSent = false;
          let provider: ChatReply["provider"] | undefined;
          let model: string | undefined;
          let streamError: unknown;
          let iterator: AsyncIterator<ChatReplyStreamChunk> | undefined;

          try {
            iterator = pipeline
              .stream(parsedMessages.messages, pipelineOptions)
              [Symbol.asyncIterator]();
            for (;;) {
              const result = await waitWithAbort(iterator.next(), scope.signal);
              if (result.done) break;
              const chunk = result.value;

              if (scope.timedOut) {
                throw scope.signal.reason ?? new Error("Request timed out");
              }
              if (scope.cancelled && !scope.timedOut) return;

              if (chunk.type === "delta") {
                controller.enqueue(
                  ndjsonEvent({ type: "delta", text: chunk.text }),
                );
                continue;
              }

              if (chunk.type === "tool") {
                controller.enqueue(
                  ndjsonEvent({ type: "tool", activity: chunk.activity }),
                );
                continue;
              }

              const message = canonicalMessage(chunk.reply);
              provider = chunk.reply.provider;
              model = chunk.reply.model;
              controller.enqueue(
                ndjsonEvent({
                  type: "done",
                  message,
                  ...replyMetadata(chunk.reply),
                }),
              );
              terminalEventSent = true;
              break;
            }

            if (!terminalEventSent && !scope.cancelled) {
              const message = scope.timedOut
                ? TIMEOUT_ERROR
                : STREAM_ENDED_ERROR;
              controller.enqueue(
                ndjsonEvent({
                  type: "error",
                  error: message,
                  code: scope.timedOut
                    ? "request_timeout"
                    : "generation_unavailable",
                }),
              );
              terminalEventSent = true;
            }
          } catch (error) {
            streamError = error;
            if (scope.cancelled && !scope.timedOut) return;

            const publicError = publicPipelineError(error, scope);
            controller.enqueue(
              ndjsonEvent({
                type: "error",
                error: publicError.message,
                code: publicError.code,
              }),
            );
            terminalEventSent = true;
          } finally {
            if (typeof iterator?.return === "function") {
              try {
                void Promise.resolve(iterator.return()).catch(() => {});
              } catch {
                // A broken iterator must not prevent resource release.
              }
            }
            try {
              controller.close();
            } catch {
              // The consumer may already have cancelled the stream.
            }
            scope.cleanup();
            release();
            finishLog(200, {
              ...(provider ? { provider } : {}),
              ...(model ? { model } : {}),
              ...(!terminalEventSent ? { streamOutcome: "cancelled" } : {}),
              ...(streamError
                ? { errorClass: safeErrorClass(streamError) }
                : {}),
            });
          }
        },
        cancel(reason) {
          scope.cancel(reason);
        },
      });

      streamOwnsResources = true;
      return new Response(stream, { status: 200, headers });
    } catch (error) {
      return respondError(
        DEFAULT_CHAT_ERROR_MESSAGE,
        "generation_unavailable",
        500,
        undefined,
        { errorClass: safeErrorClass(error) },
      );
    } finally {
      if (!streamOwnsResources) {
        scope.cleanup();
        release();
      }
    }
  };
}

let defaultHandler: ((request: Request) => Promise<Response>) | undefined;

/** Production entry point. `server.ts` validates and caches configuration before binding. */
export async function handleRequest(request: Request): Promise<Response> {
  defaultHandler ??= createRequestHandler({ config: getServiceConfig() });
  return defaultHandler(request);
}
