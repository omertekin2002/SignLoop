// Ported from SignLoop apps/web/lib/chat.ts at 3f830abaae4d47dedecabea3fca57a4899a8f688.
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { OPENROUTER_FALLBACK_MODELS } from "../config";
import { withAbort } from "./bounded-response";
import {
  GenerationUnavailableError,
  createRestrictedProviderFetch,
  isEligibleOpenRouterFallback,
  safeProviderFailureMetadata,
  type ProviderConfig,
  type LlmFallbackLogger,
  type LlmProvider,
  type FetchImplementation,
  type SafeProviderFailure,
} from "./llm-client";
export const FIRST_CHUNK_TIMEOUT_MS = 20_000;
// Gemini streams nothing while it thinks, and high thinking can run well past the default opening
// deadline. Its first-party API rarely accepts a request and then goes silent, so it waits longer.
export const GEMINI_FIRST_CHUNK_TIMEOUT_MS = 90_000;

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
const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

type RoutedCandidate = ReturnType<ReturnType<typeof createOpenAI>["responses"]>;
type StreamOptions = Parameters<RoutedCandidate["doStream"]>[0];
type StreamResult = Awaited<ReturnType<RoutedCandidate["doStream"]>>;
type StreamPart =
  StreamResult["stream"] extends ReadableStream<infer P> ? P : never;

export class FirstChunkTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Provider sent no response within ${timeoutMs}ms`);
    this.name = "FirstChunkTimeoutError";
  }
}

// Opens a provider stream and waits for its first content part, so an endpoint that accepts the
// request but never answers fails like a refused connection instead of consuming the whole budget.
async function openStreamWithDeadline(
  candidate: RoutedCandidate,
  options: StreamOptions,
  timeoutMs: number,
): Promise<StreamResult> {
  const outer = options.abortSignal;
  const deadline = new AbortController();
  // Compose instead of forwarding the outer abort through a hand-attached listener. That listener
  // has to outlive this function — it is what cancels an in-flight provider request once the
  // stream is already being consumed — so it could never be detached here, and `outer` is the one
  // per-request signal shared by every step of the tool loop: each step left another listener, and
  // another retained AbortController, on it. AbortSignal.any keeps its link to the sources weak,
  // so the composite and the link are collected with the stream that uses them.
  const signal = outer
    ? AbortSignal.any([outer, deadline.signal])
    : deadline.signal;
  const aborted = new Promise<never>((_, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), {
      once: true,
    });
  });
  aborted.catch(() => {});
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    deadline.abort(new FirstChunkTimeoutError(timeoutMs));
  }, timeoutMs);
  let reader: ReadableStreamDefaultReader<StreamPart> | undefined;
  try {
    const result = await Promise.race([
      candidate.doStream({ ...options, abortSignal: signal }),
      aborted,
    ]);
    reader = result.stream.getReader();
    const buffered: StreamPart[] = [];
    let closed = false;
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), aborted]);
      if (done) {
        closed = true;
        break;
      }
      buffered.push(value);
      if (buffered.length > 256)
        throw new Error("Provider sent too many opening events");
      // Metadata/text-start can arrive long before useful output. Keep the opening deadline
      // until content, a tool event, an error, or completion makes retrying inappropriate.
      if (
        ![
          "stream-start",
          "response-metadata",
          "text-start",
          "reasoning-start",
          "raw",
        ].includes(value.type)
      )
        break;
    }
    const source = reader;
    const stream = new ReadableStream<StreamPart>({
      start(sink) {
        for (const part of buffered) sink.enqueue(part);
        if (closed) sink.close();
      },
      async pull(sink) {
        const { done, value } = await withAbort(source.read(), signal);
        if (done) sink.close();
        else sink.enqueue(value);
      },
      cancel: (reason) => source.cancel(reason),
    });
    return { ...result, stream };
  } catch (error) {
    reader?.cancel().catch(() => {});
    if (timedOut && !outer?.aborted)
      throw new FirstChunkTimeoutError(timeoutMs);
    throw error;
  } finally {
    clearTimeout(timer);
  }
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
      ? (config.openRouter.models ?? OPENROUTER_FALLBACK_MODELS).map((model) => ({
          provider: "openrouter" as const,
          model,
        }))
      : []),
  ];
}

// Switch providers only when opening a model step fails or the provider never starts answering.
// Completed tool results remain in the agent's transcript; a stream that already delivered content
// is never replayed on another provider. Exported for tests.
export function createRoutedModel(
  config: ProviderConfig,
  options: {
    firstChunkTimeoutMs?: number;
    logger?: LlmFallbackLogger;
    fetch?: FetchImplementation;
  } = {},
) {
  const firstChunkTimeoutOverride = options.firstChunkTimeoutMs;
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  const openAiCompatible = (url: string, key: string, model: string) =>
    createOpenAI({
      baseURL: url,
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
    }).responses(model);
  const languageModel = (
    provider: LlmProvider,
    model: string,
  ): RoutedCandidate => {
    switch (provider) {
      case "gemini":
        // Explicit key and base URL keep ambient GOOGLE_GENERATIVE_AI_* settings out of routing.
        // Gemini authenticates with x-goog-api-key, so the OpenAI-shaped restricted fetch
        // (which rebuilds a Bearer header) does not apply here.
        return createGoogleGenerativeAI({
          apiKey: config.gemini!.apiKey,
          baseURL: GEMINI_BASE_URL,
          fetch: fetchImplementation as typeof globalThis.fetch,
        }).languageModel(model);
      case "primary-openai-compatible":
        return openAiCompatible(
          config.primary!.baseURL,
          config.primary!.apiKey || "not-required",
          model,
        );
      case "openrouter":
        return openAiCompatible(
          config.openRouter!.baseURL,
          config.openRouter!.apiKey || "not-required",
          model,
        );
    }
  };
  const candidates = listProviderCandidates(config).map((candidate) => ({
    ...candidate,
    languageModel: languageModel(candidate.provider, candidate.model),
  }));
  if (!candidates.length) throw new GenerationUnavailableError([]);
  const failures: SafeProviderFailure[] = [];
  let index = 0;
  const base = candidates[0]!.languageModel;
  async function attempt<T>(
    signal: AbortSignal | undefined,
    run: (candidate: (typeof candidates)[number]) => PromiseLike<T>,
  ): Promise<T> {
    for (;;) {
      signal?.throwIfAborted();
      try {
        return await run(candidates[index]!);
      } catch (error) {
        if (signal?.aborted) throw error;
        const candidate = candidates[index]!;
        const failure = safeProviderFailureMetadata(
          candidate.provider,
          candidate.model,
          error,
        );
        failures.push(failure);
        options.logger?.warn("Chat provider step failed", {
          event: "provider_failure",
          ...failure,
        });
        if (
          index === candidates.length - 1 ||
          (candidate.provider === "openrouter" &&
            !isEligibleOpenRouterFallback(error))
        ) {
          throw new GenerationUnavailableError(failures);
        }
        index++;
      }
    }
  }
  return {
    selected: () => ({
      provider: candidates[index]!.provider,
      model: candidates[index]!.model,
    }),
    model: {
      specificationVersion: base.specificationVersion,
      provider: base.provider,
      modelId: base.modelId,
      supportedUrls: base.supportedUrls,
      doGenerate: (options: Parameters<RoutedCandidate["doGenerate"]>[0]) =>
        attempt(options.abortSignal, (candidate) =>
          candidate.languageModel.doGenerate(options),
        ),
      doStream: (options: StreamOptions) =>
        attempt(options.abortSignal, (candidate) =>
          openStreamWithDeadline(
            candidate.languageModel,
            options,
            openingDeadlineMs(candidate.provider, firstChunkTimeoutOverride),
          ),
        ),
    },
  };
}
