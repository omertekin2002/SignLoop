import type { LanguageModel } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { withAbort } from "./bounded-response";
import {
  safeProviderFailureMetadata,
  type SafeProviderFailure,
} from "./provider-failure";

/** An AI SDK language model object (not a gateway model id string). */
export type ChatLanguageModel = Extract<
  LanguageModel,
  { specificationVersion: "v4" }
>;
type StreamOptions = Parameters<ChatLanguageModel["doStream"]>[0];
type GenerateOptions = Parameters<ChatLanguageModel["doGenerate"]>[0];
type StreamResult = Awaited<ReturnType<ChatLanguageModel["doStream"]>>;
type StreamPart =
  StreamResult["stream"] extends ReadableStream<infer P> ? P : never;
export type ChatProviderOptions = NonNullable<StreamOptions["providerOptions"]>;

/** Provider-start milestones reported once per request, across fallbacks and tool-loop steps. */
export type ProviderMilestone = "provider_start" | "provider_first_useful";

// A provider that accepts the request but sends nothing back is treated as down and skipped.
export const DEFAULT_FIRST_CHUNK_TIMEOUT_MS = 20_000;

/**
 * One entry in the ordered provider chain. Every model step starts at the candidate that served the
 * previous step and moves down the list only when opening the step fails or the provider never
 * starts answering.
 */
export type ChatProviderCandidate = {
  /** Label reported as `ChatReply.provider` and in failure logs, e.g. "openrouter". */
  provider: string;
  model: string;
  /** Opening deadline for this candidate; defaults to the request-level deadline. */
  firstChunkTimeoutMs?: number;
  /**
   * Provider options merged over the engine's defaults (by provider key) for steps this candidate
   * serves, e.g. `{ google: { thinkingConfig: { thinkingLevel: "high" } } }`.
   */
  providerOptions?: ChatProviderOptions;
  /** Return false to end the chain on this error instead of trying the next candidate. */
  shouldFallback?: (error: unknown) => boolean;
} & (
  | {
      /** An OpenAI-compatible Responses endpoint, called through @ai-sdk/openai. */
      kind: "openai-responses";
      baseURL: string;
      apiKey?: string;
      headers?: Record<string, string>;
      fetch?: typeof globalThis.fetch;
    }
  | {
      /** Any AI SDK model built by the caller, such as native Gemini via @ai-sdk/google. */
      kind: "language-model";
      languageModel: ChatLanguageModel;
    }
);

export type ChatRoutingOptions = {
  firstChunkTimeoutMs?: number;
  onTiming?: (event: ProviderMilestone) => void;
  /** Receives allowlisted metadata for each failed step; defaults to a console warning. */
  onProviderFailure?: (failure: SafeProviderFailure) => void;
  /** Error to throw once no candidate is left; defaults to rethrowing the last failure. */
  createExhaustedError?: (
    failures: readonly SafeProviderFailure[],
    lastError: unknown,
  ) => unknown;
};

export class FirstChunkTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Provider sent no response within ${timeoutMs}ms`);
    this.name = "FirstChunkTimeoutError";
  }
}

// Opens a provider stream and waits for its first content part, so an endpoint that accepts the
// request but never answers fails like a refused connection instead of consuming the whole budget.
async function openStreamWithDeadline(
  candidate: ChatLanguageModel,
  options: StreamOptions,
  timeoutMs: number,
  onTiming?: (event: ProviderMilestone) => void,
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
  let usefulReported = false;
  const reportUseful = (part: StreamPart) => {
    if (usefulReported) return;
    if (
      ((part.type === "text-delta" ||
        part.type === "reasoning-delta" ||
        part.type === "tool-input-delta") &&
        part.delta.length > 0) ||
      part.type === "tool-input-start" ||
      part.type === "tool-call" ||
      part.type === "file"
    ) {
      usefulReported = true;
      onTiming?.("provider_first_useful");
    }
  };
  try {
    onTiming?.("provider_start");
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
      reportUseful(value);
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
        else {
          reportUseful(value);
          sink.enqueue(value);
        }
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

function createLanguageModel(
  candidate: ChatProviderCandidate,
): ChatLanguageModel {
  if (candidate.kind === "language-model") return candidate.languageModel;
  return createOpenAI({
    baseURL: candidate.baseURL,
    apiKey: candidate.apiKey || "not-required",
    ...(candidate.headers ? { headers: candidate.headers } : {}),
    ...(candidate.fetch ? { fetch: candidate.fetch } : {}),
  }).responses(candidate.model);
}

function withCandidateOptions<T extends { providerOptions?: ChatProviderOptions }>(
  options: T,
  candidate: ChatProviderCandidate,
): T {
  return candidate.providerOptions
    ? {
        ...options,
        providerOptions: {
          ...options.providerOptions,
          ...candidate.providerOptions,
        },
      }
    : options;
}

// Switch providers only when opening a model step fails or the provider never starts answering.
// Completed tool results remain in the agent's transcript; a stream that already delivered content
// is never replayed on another provider.
export function createRoutedModel(
  candidates: readonly ChatProviderCandidate[],
  options: ChatRoutingOptions = {},
) {
  const firstChunkTimeoutMs =
    options.firstChunkTimeoutMs ?? DEFAULT_FIRST_CHUNK_TIMEOUT_MS;
  // Request-level firsts, even across failed candidates and later tool-loop steps.
  const reported = new Set<ProviderMilestone>();
  const reportTiming = (event: ProviderMilestone) => {
    if (reported.has(event)) return;
    reported.add(event);
    options.onTiming?.(event);
  };
  const onProviderFailure =
    options.onProviderFailure ??
    ((failure: SafeProviderFailure) =>
      console.warn("Chat provider step failed", failure));
  if (!candidates.length) throw new Error("No chat provider is configured");
  const models = candidates.map(createLanguageModel);
  const failures: SafeProviderFailure[] = [];
  let index = 0;
  const base = models[0]!;
  async function attempt<T>(
    signal: AbortSignal | undefined,
    run: (
      model: ChatLanguageModel,
      candidate: ChatProviderCandidate,
    ) => PromiseLike<T>,
  ): Promise<T> {
    for (;;) {
      signal?.throwIfAborted();
      const candidate = candidates[index]!;
      try {
        return await run(models[index]!, candidate);
      } catch (error) {
        if (signal?.aborted) throw error;
        const failure = safeProviderFailureMetadata(
          candidate.provider,
          candidate.model,
          error,
        );
        failures.push(failure);
        onProviderFailure(failure);
        if (
          index === models.length - 1 ||
          candidate.shouldFallback?.(error) === false
        )
          throw options.createExhaustedError
            ? options.createExhaustedError([...failures], error)
            : error;
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
      doGenerate: (callOptions: GenerateOptions) =>
        attempt(callOptions.abortSignal, (model, candidate) =>
          model.doGenerate(withCandidateOptions(callOptions, candidate)),
        ),
      doStream: (callOptions: StreamOptions) =>
        attempt(callOptions.abortSignal, (model, candidate) =>
          openStreamWithDeadline(
            model,
            withCandidateOptions(callOptions, candidate),
            candidate.firstChunkTimeoutMs ?? firstChunkTimeoutMs,
            reportTiming,
          ),
        ),
    },
  };
}
