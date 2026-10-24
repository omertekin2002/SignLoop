import { afterEach, describe, expect, it, vi } from "vitest";

import { InferenceSemaphore } from "../src/concurrency";
import type { ServiceConfig } from "../src/config";
import {
  createRequestHandler,
  type ChatPipeline,
  type StructuredLogSink,
} from "../src/handler";
import type { ChatReply } from "../src/pipeline/chat";
import { MAX_CHAT_REQUEST_BODY_BYTES } from "../src/pipeline/chat-policy";
import { GenerationUnavailableError } from "../src/pipeline/llm-client";
import { ResearchUnavailableError } from "../src/pipeline/research-policy";
import { DEFAULT_CHAT_ERROR_MESSAGE } from "../src/prompts";

const TEST_URL = "http://service.test";

function makeConfig(overrides: Partial<ServiceConfig> = {}): ServiceConfig {
  return {
    primaryLlm: {
      baseUrl: "https://primary.internal.example/v1",
      apiKey: "primary-secret-never-return",
      model: "server-controlled-model",
      modelWasDefaulted: false,
    },
    openRouter: null,
    webTools: {
      geminiApiKey: "gemini-secret-never-return",
      geminiModel: "gemini-test-model",
    },
    geminiChat: {
      apiKey: "gemini-secret-never-return",
      model: "gemini-test-model",
    },
    imageGenerationEnabled: false,
    imageGenerationModel: "gpt-image-2",
    publicServiceUrl: TEST_URL,
    appName: "SignLoop test service",
    port: 10_000,
    maxConcurrentRequests: 2,
    requestTimeoutMs: 5_000,
    corsAllowedOrigins: new Set<string>(),
    ...overrides,
  };
}

function makeReply(overrides: Partial<ChatReply> = {}): ChatReply {
  return {
    message: "Assistant response",
    provider: "primary-openai-compatible",
    model: "server-controlled-model",
    webSearch: null,
    ...overrides,
  };
}

function makePipeline(reply: ChatReply = makeReply()) {
  const generate = vi.fn<ChatPipeline["generate"]>(async () => reply);
  const stream = vi.fn<ChatPipeline["stream"]>(async function* () {
    yield { type: "done", reply };
  });

  return {
    pipeline: { generate, stream } satisfies ChatPipeline,
    generate,
    stream,
  };
}

type ChatRequestOptions = {
  contentType?: string | null;
  headers?: HeadersInit;
  signal?: AbortSignal;
};

function chatRequest(body: unknown, options: ChatRequestOptions = {}): Request {
  const headers = new Headers(options.headers);
  const contentType =
    options.contentType === undefined
      ? "application/json"
      : options.contentType;

  if (contentType !== null) headers.set("Content-Type", contentType);

  return new Request(`${TEST_URL}/v1/chat`, {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
    signal: options.signal,
  });
}

function nonStreamingBody(extra: Record<string, unknown> = {}) {
  return {
    messages: [{ role: "user", content: "Explain this clause." }],
    stream: false,
    ...extra,
  };
}

function parseNdjson(text: string): Array<Record<string, unknown>> {
  expect(text.endsWith("\n")).toBe(true);
  expect(text.endsWith("\n\n")).toBe(false);

  const lines = text.split("\n");
  expect(lines.at(-1)).toBe("");
  lines.pop();
  expect(lines.every((line) => line.length > 0)).toBe(true);

  return lines.map((line) => JSON.parse(line) as Record<string, unknown>);
}

function hangingUploadRequest(options: {
  signal?: AbortSignal;
  cancel: (reason?: unknown) => void | Promise<void>;
}): Request {
  const body = new ReadableStream<Uint8Array>({
    // Deliberately never enqueue or close, simulating a client that stalls mid-upload.
    start() {},
    cancel: options.cancel,
  });

  return new Request(`${TEST_URL}/v1/chat`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body,
    signal: options.signal,
    duplex: "half",
  } as RequestInit & { duplex: "half" });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("HTTP routing", () => {
  it("serves health without pipeline work", async () => {
    const { pipeline, generate, stream } = makePipeline();
    const handler = createRequestHandler({
      config: makeConfig(),
      pipeline,
      log: vi.fn(),
      requestIdFactory: () => "health-request-id",
    });

    const response = await handler(new Request(`${TEST_URL}/healthz`));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      service: "signloop-chat-service",
    });
    expect(generate).not.toHaveBeenCalled();
    expect(stream).not.toHaveBeenCalled();
  });

  it("returns 404 for unknown routes and unsupported methods", async () => {
    const { pipeline } = makePipeline();
    const handler = createRequestHandler({
      config: makeConfig(),
      pipeline,
      log: vi.fn(),
    });

    const unknown = await handler(new Request(`${TEST_URL}/missing`));
    const wrongMethod = await handler(
      new Request(`${TEST_URL}/v1/chat`, { method: "GET" }),
    );

    expect(unknown.status).toBe(404);
    await expect(unknown.json()).resolves.toEqual({
      error: "Not found",
      code: "invalid_request",
    });
    expect(wrongMethod.status).toBe(404);
  });

  it("accepts chat requests without credentials", async () => {
    const { pipeline, generate } = makePipeline();
    const handler = createRequestHandler({
      config: makeConfig(),
      pipeline,
      log: vi.fn(),
    });

    const response = await handler(chatRequest(nonStreamingBody()));

    expect(response.status).toBe(200);
    expect(generate).toHaveBeenCalledOnce();
  });
});

describe("HTTP request parsing and policy", () => {
  it("requires an application/json content type", async () => {
    const { pipeline, generate } = makePipeline();
    const handler = createRequestHandler({
      config: makeConfig(),
      pipeline,
      log: vi.fn(),
    });

    const response = await handler(
      chatRequest(nonStreamingBody(), { contentType: "text/plain" }),
    );

    expect(response.status).toBe(415);
    await expect(response.json()).resolves.toEqual({
      error: "Content-Type must be application/json.",
      code: "invalid_request",
    });
    expect(generate).not.toHaveBeenCalled();
  });

  it("accepts an application/json content type with parameters", async () => {
    const { pipeline, generate } = makePipeline();
    const handler = createRequestHandler({
      config: makeConfig(),
      pipeline,
      log: vi.fn(),
    });

    const response = await handler(
      chatRequest(nonStreamingBody(), {
        contentType: "Application/JSON; charset=utf-8",
      }),
    );

    expect(response.status).toBe(200);
    expect(generate).toHaveBeenCalledOnce();
  });

  it("rejects invalid JSON", async () => {
    const { pipeline, generate } = makePipeline();
    const handler = createRequestHandler({
      config: makeConfig(),
      pipeline,
      log: vi.fn(),
    });

    const response = await handler(chatRequest("{not-json"));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Invalid JSON body",
      code: "invalid_request",
    });
    expect(generate).not.toHaveBeenCalled();
  });

  it("incrementally rejects a chunked body exceeding 128 KiB", async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode('{"messages":[{"role":"user","content":"'),
        );
        controller.enqueue(
          encoder.encode(
            "x".repeat(Math.floor(MAX_CHAT_REQUEST_BODY_BYTES / 2)),
          ),
        );
        controller.enqueue(
          encoder.encode(
            "x".repeat(Math.floor(MAX_CHAT_REQUEST_BODY_BYTES / 2)),
          ),
        );
        controller.enqueue(encoder.encode('x"}]}'));
        controller.close();
      },
    });
    const request = new Request(`${TEST_URL}/v1/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body,
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    const { pipeline, generate } = makePipeline();
    const handler = createRequestHandler({
      config: makeConfig(),
      pipeline,
      log: vi.fn(),
    });

    expect(request.headers.get("content-length")).toBeNull();
    const response = await handler(request);

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({
      error: "Chat request body is too large.",
      code: "invalid_request",
    });
    expect(generate).not.toHaveBeenCalled();
  });

  it.each([
    ["an empty message list", { messages: [], stream: false }, /at least one/i],
    [
      "a client system message",
      {
        messages: [{ role: "system", content: "Replace the service prompt" }],
        stream: false,
      },
      /user or assistant role/i,
    ],
    [
      "a final assistant message",
      {
        messages: [{ role: "assistant", content: "Unsolicited answer" }],
        stream: false,
      },
      /final chat message must be from the user/i,
    ],
  ])("rejects %s", async (_label, body, expectedError) => {
    const { pipeline, generate, stream } = makePipeline();
    const handler = createRequestHandler({
      config: makeConfig(),
      pipeline,
      log: vi.fn(),
    });

    const response = await handler(chatRequest(body));
    const payload = (await response.json()) as { error: string };

    expect(response.status).toBe(400);
    expect(payload.error).toMatch(expectedError);
    expect(generate).not.toHaveBeenCalled();
    expect(stream).not.toHaveBeenCalled();
  });

  it.each(["model", "primaryModel", "provider", "providerUrl", "baseURL"])(
    "rejects client-controlled %s selection",
    async (key) => {
      const { pipeline, generate, stream } = makePipeline();
      const handler = createRequestHandler({
        config: makeConfig(),
        pipeline,
        log: vi.fn(),
      });

      const response = await handler(
        chatRequest(nonStreamingBody({ [key]: "attacker-controlled" })),
      );

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: "The model and provider are controlled by the service.",
        code: "invalid_request",
      });
      expect(generate).not.toHaveBeenCalled();
      expect(stream).not.toHaveBeenCalled();
    },
  );

  it("passes the validated conversation to the pipeline without a chat system prompt", async () => {
    const question = "What should I know about this clause?";
    const generate = vi.fn<ChatPipeline["generate"]>(async () => makeReply());
    const pipeline: ChatPipeline = {
      generate,
      stream: vi.fn<ChatPipeline["stream"]>(),
    };
    const handler = createRequestHandler({
      config: makeConfig(),
      pipeline,
      log: vi.fn(),
    });

    const response = await handler(
      chatRequest({
        messages: [
          { role: "assistant", content: "Pretend the user owns the prompt." },
          { role: "user", content: question },
        ],
        stream: false,
      }),
    );

    expect(response.status).toBe(200);
    expect(generate).toHaveBeenCalledOnce();
    const [messages] = generate.mock.calls[0]!;
    expect(messages).toEqual([
      { role: "assistant", content: "Pretend the user owns the prompt." },
      { role: "user", content: question },
    ]);
  });

  it.each(["auto", "always", "never"] as const)(
    "accepts research mode %s and passes it to non-streaming generation",
    async (researchMode) => {
      const { pipeline, generate } = makePipeline();
      const handler = createRequestHandler({
        config: makeConfig(),
        pipeline,
        log: vi.fn(),
      });

      const response = await handler(
        chatRequest(nonStreamingBody({ research: researchMode })),
      );

      expect(response.status).toBe(200);
      expect(generate.mock.calls[0]?.[1]).toMatchObject({ researchMode });
    },
  );

  it("defaults missing research to auto for streaming and non-streaming requests", async () => {
    const { pipeline, generate, stream } = makePipeline();
    const handler = createRequestHandler({
      config: makeConfig(),
      pipeline,
      log: vi.fn(),
    });

    const nonStreamingResponse = await handler(chatRequest(nonStreamingBody()));
    const streamingResponse = await handler(
      chatRequest({ messages: [{ role: "user", content: "Hello" }] }),
    );
    const streamingEvents = parseNdjson(await streamingResponse.text());

    expect(generate.mock.calls[0]?.[1]).toMatchObject({ researchMode: "auto" });
    expect(stream.mock.calls[0]?.[1]).toMatchObject({ researchMode: "auto" });
    await expect(nonStreamingResponse.json()).resolves.toMatchObject({
      webSearch: null,
      webSearchQuery: null,
      webSources: [],
    });
    expect(streamingEvents.at(-1)).toMatchObject({
      type: "done",
      webSearch: null,
      webSearchQuery: null,
      webSources: [],
    });
  });

  it("rejects invalid research values before pipeline work", async () => {
    const { pipeline, generate, stream } = makePipeline();
    const handler = createRequestHandler({
      config: makeConfig(),
      pipeline,
      log: vi.fn(),
      requestIdFactory: () => "invalid-research-request",
    });

    const response = await handler(
      chatRequest(nonStreamingBody({ research: "sometimes" })),
    );

    expect(response.status).toBe(400);
    expect(response.headers.get("X-Request-ID")).toBe(
      "invalid-research-request",
    );
    await expect(response.json()).resolves.toEqual({
      error: "research must be one of: auto, always, never.",
      code: "invalid_request",
    });
    expect(generate).not.toHaveBeenCalled();
    expect(stream).not.toHaveBeenCalled();
  });
});

describe("HTTP response contracts", () => {
  it("distinguishes strict research failure from generation exhaustion", async () => {
    const researchHandler = createRequestHandler({
      config: makeConfig(),
      pipeline: {
        generate: vi.fn<ChatPipeline["generate"]>(async () => {
          throw new ResearchUnavailableError();
        }),
        stream: vi.fn<ChatPipeline["stream"]>(),
      },
      log: vi.fn(),
      requestIdFactory: () => "research-failure-id",
    });
    const generationHandler = createRequestHandler({
      config: makeConfig(),
      pipeline: {
        generate: vi.fn<ChatPipeline["generate"]>(async () => {
          throw new GenerationUnavailableError([]);
        }),
        stream: vi.fn<ChatPipeline["stream"]>(),
      },
      log: vi.fn(),
      requestIdFactory: () => "generation-failure-id",
    });

    const researchResponse = await researchHandler(
      chatRequest(nonStreamingBody({ research: "always" })),
    );
    const generationResponse = await generationHandler(
      chatRequest(nonStreamingBody({ research: "never" })),
    );

    expect(researchResponse.status).toBe(502);
    expect(researchResponse.headers.get("X-Request-ID")).toBe(
      "research-failure-id",
    );
    await expect(researchResponse.json()).resolves.toEqual({
      error: "Grounded research is temporarily unavailable.",
      code: "research_unavailable",
    });
    expect(generationResponse.status).toBe(502);
    await expect(generationResponse.json()).resolves.toEqual({
      error: DEFAULT_CHAT_ERROR_MESSAGE,
      code: "generation_unavailable",
    });
  });

  it("uses the same strict research error code after a stream opens", async () => {
    const handler = createRequestHandler({
      config: makeConfig(),
      pipeline: {
        generate: vi.fn<ChatPipeline["generate"]>(),
        stream: vi.fn<ChatPipeline["stream"]>(async function* () {
          throw new ResearchUnavailableError();
          yield undefined as never;
        }),
      },
      log: vi.fn(),
    });

    const response = await handler(
      chatRequest({
        messages: [{ role: "user", content: "Find current sources." }],
        research: "always",
      }),
    );

    expect(response.status).toBe(200);
    expect(parseNdjson(await response.text())).toEqual([
      {
        type: "error",
        error: "Grounded research is temporarily unavailable.",
        code: "research_unavailable",
      },
    ]);
  });

  it("returns canonical non-streaming content with documented metadata", async () => {
    const reply = makeReply({
      message:
        "Answer with an existing [first citation](<https://one.example.test/source>).",
      provider: "openrouter",
      model: "fallback-model",
      readSources: [2],
      webSearch: {
        query: "indemnity clause law",
        attemptedQueries: ["indemnity clause", "indemnity clause law"],
        successfulSearches: 1,
        sources: [
          {
            title: "First source",
            url: "https://one.example.test/source",
            snippet: "First supported claim",
          },
          {
            title: "Second source",
            url: "https://two.example.test/source",
            snippet: null,
          },
        ],
      },
    });
    const { pipeline } = makePipeline(reply);
    const handler = createRequestHandler({
      config: makeConfig(),
      pipeline,
      log: vi.fn(),
    });

    const response = await handler(chatRequest(nonStreamingBody()));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "application/json; charset=utf-8",
    );
    await expect(response.json()).resolves.toEqual({
      message:
        "Answer with an existing [first citation](<https://one.example.test/source>).\n\nSources:\n- [2] [Second source](<https://two.example.test/source>)",
      provider: "openrouter",
      model: "fallback-model",
      webSearch: reply.webSearch,
      webSearchQuery: "indemnity clause law",
      webSearchAttempts: ["indemnity clause", "indemnity clause law"],
      webSearchSuccessfulCount: 1,
      webSources: reply.webSearch?.sources,
      readSources: reply.readSources,
      toolActivity: [],
    });
  });

  it("defaults to streaming and emits valid NDJSON with one exact terminal event", async () => {
    const reply = makeReply({
      message: "Complete canonical answer",
      readSources: [1],
      webSearch: {
        query: "current contract rule",
        attemptedQueries: ["current contract rule"],
        successfulSearches: 1,
        sources: [
          {
            title: "Authoritative source",
            url: "https://source.example.test/rule",
            snippet: "Supported rule",
          },
        ],
      },
    });
    const stream = vi.fn<ChatPipeline["stream"]>(async function* () {
      yield { type: "delta", text: "Complete " };
      yield { type: "delta", text: "canonical answer" };
      yield { type: "done", reply };
    });
    const generate = vi.fn<ChatPipeline["generate"]>();
    const semaphore = new InferenceSemaphore(1);
    const handler = createRequestHandler({
      config: makeConfig(),
      pipeline: { generate, stream },
      semaphore,
      log: vi.fn(),
      requestIdFactory: () => "stream-request-id",
    });

    const response = await handler(
      chatRequest({
        messages: [{ role: "user", content: "What is the current rule?" }],
      }),
    );
    const text = await response.text();
    const events = parseNdjson(text);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "application/x-ndjson; charset=utf-8",
    );
    expect(response.headers.get("X-Request-ID")).toBe("stream-request-id");
    expect(generate).not.toHaveBeenCalled();
    expect(stream).toHaveBeenCalledOnce();
    expect(events).toEqual([
      { type: "delta", text: "Complete " },
      { type: "delta", text: "canonical answer" },
      {
        type: "done",
        message:
          "Complete canonical answer\n\nSources:\n- [1] [Authoritative source](<https://source.example.test/rule>)",
        provider: "primary-openai-compatible",
        model: "server-controlled-model",
        webSearch: reply.webSearch,
        webSearchQuery: "current contract rule",
        webSearchAttempts: ["current contract rule"],
        webSearchSuccessfulCount: 1,
        webSources: reply.webSearch?.sources,
        readSources: reply.readSources,
        toolActivity: [],
      },
    ]);
    expect(
      events.filter((event) => event.type === "done" || event.type === "error"),
    ).toHaveLength(1);
    expect(events.at(-1)?.type).toBe("done");
    expect(text.split("\n")).toHaveLength(events.length + 1);
    expect(semaphore.active).toBe(0);
  });

  it("terminates an incomplete stream with one error event", async () => {
    const stream = vi.fn<ChatPipeline["stream"]>(async function* () {
      yield { type: "delta", text: "partial" };
    });
    const handler = createRequestHandler({
      config: makeConfig(),
      pipeline: {
        generate: vi.fn<ChatPipeline["generate"]>(),
        stream,
      },
      log: vi.fn(),
    });

    const response = await handler(
      chatRequest({
        messages: [{ role: "user", content: "Answer me." }],
      }),
    );
    const events = parseNdjson(await response.text());

    expect(events).toEqual([
      { type: "delta", text: "partial" },
      {
        type: "error",
        error: "Chat stream ended before completion.",
        code: "generation_unavailable",
      },
    ]);
    expect(events.at(-1)?.type).toBe("error");
  });

  it("returns safe non-streaming and streaming errors without credentials", async () => {
    const leaked = [
      "primary-secret-never-return",
      "gemini-secret-never-return",
      "https://primary.internal.example/v1",
      "private user prompt",
    ];
    const upstreamError = new Error(`upstream dump: ${leaked.join(" | ")}`);
    const nonStreamingLogs: unknown[] = [];
    const nonStreamingHandler = createRequestHandler({
      config: makeConfig(),
      pipeline: {
        generate: vi.fn<ChatPipeline["generate"]>(async () => {
          throw upstreamError;
        }),
        stream: vi.fn<ChatPipeline["stream"]>(),
      },
      log: (entry) => nonStreamingLogs.push(entry),
    });

    const nonStreamingResponse = await nonStreamingHandler(
      chatRequest({
        messages: [{ role: "user", content: "private user prompt" }],
        stream: false,
      }),
    );
    const nonStreamingText = await nonStreamingResponse.text();

    expect(nonStreamingResponse.status).toBe(502);
    expect(JSON.parse(nonStreamingText)).toEqual({
      error: DEFAULT_CHAT_ERROR_MESSAGE,
      code: "generation_unavailable",
    });

    const streamingHandler = createRequestHandler({
      config: makeConfig(),
      pipeline: {
        generate: vi.fn<ChatPipeline["generate"]>(),
        stream: vi.fn<ChatPipeline["stream"]>(async function* () {
          throw upstreamError;
          yield undefined as never;
        }),
      },
      log: vi.fn(),
    });
    const streamingResponse = await streamingHandler(
      chatRequest({
        messages: [{ role: "user", content: "private user prompt" }],
      }),
    );
    const streamingText = await streamingResponse.text();

    expect(parseNdjson(streamingText)).toEqual([
      {
        type: "error",
        error: DEFAULT_CHAT_ERROR_MESSAGE,
        code: "generation_unavailable",
      },
    ]);
    const publicOutput = `${nonStreamingText}\n${streamingText}\n${JSON.stringify(
      nonStreamingLogs,
    )}`;
    for (const secret of leaked) {
      expect(publicOutput).not.toContain(secret);
    }
  });
});

describe("timeouts, cancellation, and concurrency", () => {
  it("times out a never-ending upload, cancels its reader, and releases the slot", async () => {
    vi.useFakeTimers();
    const cancelBody = vi.fn(
      (_reason?: unknown) => new Promise<void>(() => {}),
    );
    const semaphore = new InferenceSemaphore(1);
    const { pipeline, generate, stream } = makePipeline();
    const handler = createRequestHandler({
      config: makeConfig({ requestTimeoutMs: 25 }),
      pipeline,
      semaphore,
      log: vi.fn(),
    });

    const responsePromise = handler(
      hangingUploadRequest({ cancel: cancelBody }),
    );
    expect(semaphore.active).toBe(1);
    await vi.advanceTimersByTimeAsync(25);
    const response = await responsePromise;

    expect(response.status).toBe(504);
    await expect(response.json()).resolves.toEqual({
      error: "Chat request timed out. Please try again.",
      code: "request_timeout",
    });
    expect(cancelBody).toHaveBeenCalledOnce();
    expect((cancelBody.mock.calls[0]?.[0] as DOMException).name).toBe(
      "TimeoutError",
    );
    expect(generate).not.toHaveBeenCalled();
    expect(stream).not.toHaveBeenCalled();
    expect(semaphore.active).toBe(0);
  });

  it("cancels a never-ending upload on client abort and releases the slot", async () => {
    const requestController = new AbortController();
    const cancelBody = vi.fn(
      (_reason?: unknown) => new Promise<void>(() => {}),
    );
    const semaphore = new InferenceSemaphore(1);
    const { pipeline, generate, stream } = makePipeline();
    const handler = createRequestHandler({
      config: makeConfig(),
      pipeline,
      semaphore,
      log: vi.fn(),
    });

    const responsePromise = handler(
      hangingUploadRequest({
        signal: requestController.signal,
        cancel: cancelBody,
      }),
    );
    expect(semaphore.active).toBe(1);
    requestController.abort(
      new DOMException("client disconnected", "AbortError"),
    );
    const response = await responsePromise;

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Request was aborted.",
      code: "invalid_request",
    });
    expect(cancelBody).toHaveBeenCalledOnce();
    expect((cancelBody.mock.calls[0]?.[0] as DOMException).name).toBe(
      "AbortError",
    );
    expect(generate).not.toHaveBeenCalled();
    expect(stream).not.toHaveBeenCalled();
    expect(semaphore.active).toBe(0);
  });

  it("releases after timeout even when a non-streaming dependency ignores abort", async () => {
    vi.useFakeTimers();
    const semaphore = new InferenceSemaphore(1);
    const handler = createRequestHandler({
      config: makeConfig({ requestTimeoutMs: 25 }),
      pipeline: {
        generate: vi.fn<ChatPipeline["generate"]>(
          () => new Promise<ChatReply>(() => {}),
        ),
        stream: vi.fn<ChatPipeline["stream"]>(),
      },
      semaphore,
      log: vi.fn(),
    });

    const responsePromise = handler(chatRequest(nonStreamingBody()));
    expect(semaphore.active).toBe(1);
    await vi.advanceTimersByTimeAsync(25);
    const response = await responsePromise;

    expect(response.status).toBe(504);
    expect(semaphore.active).toBe(0);
  });

  it("releases after timeout even when a streaming dependency ignores abort", async () => {
    vi.useFakeTimers();
    const semaphore = new InferenceSemaphore(1);
    const handler = createRequestHandler({
      config: makeConfig({ requestTimeoutMs: 25 }),
      pipeline: {
        generate: vi.fn<ChatPipeline["generate"]>(),
        stream: vi.fn<ChatPipeline["stream"]>(async function* () {
          await new Promise<void>(() => {});
          yield undefined as never;
        }),
      },
      semaphore,
      log: vi.fn(),
    });

    const response = await handler(
      chatRequest({
        messages: [{ role: "user", content: "Never answer." }],
      }),
    );
    const bodyPromise = response.text();
    expect(semaphore.active).toBe(1);
    await vi.advanceTimersByTimeAsync(25);

    expect(parseNdjson(await bodyPromise)).toEqual([
      {
        type: "error",
        error: "Chat request timed out. Please try again.",
        code: "request_timeout",
      },
    ]);
    expect(semaphore.active).toBe(0);
  });

  it("propagates timeout abort and rejects a late successful result with 504", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let resolveReply!: (reply: ChatReply) => void;
    const lateReply = new Promise<ChatReply>((resolve) => {
      resolveReply = resolve;
    });
    const generate = vi.fn<ChatPipeline["generate"]>(
      async (_messages, options) => {
        signal = options.signal;
        markStarted();
        return lateReply;
      },
    );
    const semaphore = new InferenceSemaphore(1);
    const handler = createRequestHandler({
      config: makeConfig({ requestTimeoutMs: 25 }),
      pipeline: {
        generate,
        stream: vi.fn<ChatPipeline["stream"]>(),
      },
      semaphore,
      log: vi.fn(),
    });

    const responsePromise = handler(chatRequest(nonStreamingBody()));
    await started;
    expect(semaphore.active).toBe(1);
    await vi.advanceTimersByTimeAsync(25);

    expect(signal?.aborted).toBe(true);
    expect((signal?.reason as DOMException).name).toBe("TimeoutError");
    resolveReply(makeReply({ message: "Too late" }));
    const response = await responsePromise;

    expect(response.status).toBe(504);
    await expect(response.json()).resolves.toEqual({
      error: "Chat request timed out. Please try again.",
      code: "request_timeout",
    });
    expect(semaphore.active).toBe(0);
  });

  it("turns a stream chunk arriving after timeout into a terminal timeout error", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let releaseChunk!: () => void;
    const chunkGate = new Promise<void>((resolve) => {
      releaseChunk = resolve;
    });
    const stream = vi.fn<ChatPipeline["stream"]>(
      async function* (_messages, options) {
        signal = options.signal;
        markStarted();
        await chunkGate;
        yield { type: "done", reply: makeReply({ message: "Too late" }) };
      },
    );
    const semaphore = new InferenceSemaphore(1);
    const handler = createRequestHandler({
      config: makeConfig({ requestTimeoutMs: 25 }),
      pipeline: {
        generate: vi.fn<ChatPipeline["generate"]>(),
        stream,
      },
      semaphore,
      log: vi.fn(),
    });

    const response = await handler(
      chatRequest({
        messages: [{ role: "user", content: "Answer slowly." }],
      }),
    );
    await started;
    await vi.advanceTimersByTimeAsync(25);
    expect(signal?.aborted).toBe(true);
    releaseChunk();

    expect(parseNdjson(await response.text())).toEqual([
      {
        type: "error",
        error: "Chat request timed out. Please try again.",
        code: "request_timeout",
      },
    ]);
    expect(semaphore.active).toBe(0);
  });

  it("releases the inference slot after non-streaming success", async () => {
    const semaphore = new InferenceSemaphore(1);
    const { pipeline } = makePipeline();
    const handler = createRequestHandler({
      config: makeConfig(),
      pipeline,
      semaphore,
      log: vi.fn(),
    });

    const response = await handler(chatRequest(nonStreamingBody()));

    expect(response.status).toBe(200);
    expect(semaphore.active).toBe(0);
  });

  it("releases the inference slot after pipeline failure", async () => {
    const semaphore = new InferenceSemaphore(1);
    const handler = createRequestHandler({
      config: makeConfig(),
      pipeline: {
        generate: vi.fn<ChatPipeline["generate"]>(async () => {
          throw new Error("provider failed");
        }),
        stream: vi.fn<ChatPipeline["stream"]>(),
      },
      semaphore,
      log: vi.fn(),
    });

    const response = await handler(chatRequest(nonStreamingBody()));

    expect(response.status).toBe(502);
    expect(semaphore.active).toBe(0);
  });

  it("returns a terminal error and releases when stream creation throws", async () => {
    const semaphore = new InferenceSemaphore(1);
    const stream = vi.fn(() => {
      throw new Error("stream factory failed");
    }) as unknown as ChatPipeline["stream"];
    const handler = createRequestHandler({
      config: makeConfig(),
      pipeline: {
        generate: vi.fn<ChatPipeline["generate"]>(),
        stream,
      },
      semaphore,
      log: vi.fn(),
    });

    const response = await handler(
      chatRequest({ messages: [{ role: "user", content: "Answer." }] }),
    );

    expect(parseNdjson(await response.text())).toEqual([
      {
        type: "error",
        error: DEFAULT_CHAT_ERROR_MESSAGE,
        code: "generation_unavailable",
      },
    ]);
    expect(semaphore.active).toBe(0);
  });

  it("propagates request cancellation and releases the inference slot", async () => {
    const requestController = new AbortController();
    const semaphore = new InferenceSemaphore(1);
    let pipelineSignal: AbortSignal | undefined;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const generate = vi.fn<ChatPipeline["generate"]>(
      async (_messages, options) => {
        pipelineSignal = options.signal;
        markStarted();
        return new Promise<ChatReply>((_resolve, reject) => {
          const rejectForAbort = () => reject(options.signal.reason);
          if (options.signal.aborted) rejectForAbort();
          else {
            options.signal.addEventListener("abort", rejectForAbort, {
              once: true,
            });
          }
        });
      },
    );
    const handler = createRequestHandler({
      config: makeConfig(),
      pipeline: {
        generate,
        stream: vi.fn<ChatPipeline["stream"]>(),
      },
      semaphore,
      log: vi.fn(),
    });

    const responsePromise = handler(
      chatRequest(nonStreamingBody(), { signal: requestController.signal }),
    );
    await started;
    expect(semaphore.active).toBe(1);
    requestController.abort(
      new DOMException("client disconnected", "AbortError"),
    );
    const response = await responsePromise;

    expect(pipelineSignal?.aborted).toBe(true);
    expect((pipelineSignal?.reason as DOMException).name).toBe("AbortError");
    expect(response.status).toBe(502);
    expect(semaphore.active).toBe(0);
  });

  it("returns 429 with Retry-After while capacity is exhausted", async () => {
    const semaphore = new InferenceSemaphore(1);
    const occupiedRelease = semaphore.tryAcquire();
    const { pipeline, generate, stream } = makePipeline();
    const handler = createRequestHandler({
      config: makeConfig(),
      pipeline,
      semaphore,
      log: vi.fn(),
    });

    const response = await handler(chatRequest(nonStreamingBody()));

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("1");
    await expect(response.json()).resolves.toEqual({
      error: "Too many concurrent chat requests. Please retry shortly.",
      code: "service_busy",
    });
    expect(generate).not.toHaveBeenCalled();
    expect(stream).not.toHaveBeenCalled();
    occupiedRelease?.();
    expect(semaphore.active).toBe(0);
  });
});

describe("CORS and request IDs", () => {
  it("omits CORS headers by default", async () => {
    const { pipeline } = makePipeline();
    const handler = createRequestHandler({
      config: makeConfig(),
      pipeline,
      log: vi.fn(),
    });

    const response = await handler(
      new Request(`${TEST_URL}/healthz`, {
        headers: { Origin: "https://client.example.test" },
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(response.headers.get("Access-Control-Allow-Credentials")).toBeNull();
    expect(response.headers.get("Vary")).toBeNull();
  });

  it("emits CORS only for an explicitly allowlisted origin", async () => {
    const allowedOrigin = "https://allowed.example.test";
    const { pipeline } = makePipeline();
    const handler = createRequestHandler({
      config: makeConfig({ corsAllowedOrigins: new Set([allowedOrigin]) }),
      pipeline,
      log: vi.fn(),
    });

    const allowed = await handler(
      new Request(`${TEST_URL}/healthz`, {
        headers: { Origin: allowedOrigin },
      }),
    );
    const denied = await handler(
      new Request(`${TEST_URL}/healthz`, {
        headers: { Origin: "https://denied.example.test" },
      }),
    );

    expect(allowed.headers.get("Access-Control-Allow-Origin")).toBe(
      allowedOrigin,
    );
    expect(allowed.headers.get("Vary")).toBe("Origin");
    expect(allowed.headers.get("Access-Control-Allow-Credentials")).toBeNull();
    expect(denied.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("handles allowlisted preflight without authentication and rejects others", async () => {
    const allowedOrigin = "https://allowed.example.test";
    const { pipeline, generate, stream } = makePipeline();
    const handler = createRequestHandler({
      config: makeConfig({ corsAllowedOrigins: new Set([allowedOrigin]) }),
      pipeline,
      log: vi.fn(),
    });

    const allowed = await handler(
      new Request(`${TEST_URL}/v1/chat`, {
        method: "OPTIONS",
        headers: {
          Origin: allowedOrigin,
          "Access-Control-Request-Method": "POST",
        },
      }),
    );
    const denied = await handler(
      new Request(`${TEST_URL}/v1/chat`, {
        method: "OPTIONS",
        headers: { Origin: "https://denied.example.test" },
      }),
    );

    expect(allowed.status).toBe(204);
    expect(allowed.headers.get("Access-Control-Allow-Origin")).toBe(
      allowedOrigin,
    );
    expect(allowed.headers.get("Access-Control-Allow-Methods")).toBe(
      "POST, OPTIONS",
    );
    expect(allowed.headers.get("Access-Control-Allow-Headers")).toBe(
      "Content-Type, X-Request-ID",
    );
    expect(allowed.headers.get("Access-Control-Max-Age")).toBe("600");
    expect(denied.status).toBe(404);
    expect(denied.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(generate).not.toHaveBeenCalled();
    expect(stream).not.toHaveBeenCalled();
  });

  it("propagates a valid X-Request-ID and replaces an invalid one", async () => {
    const { pipeline } = makePipeline();
    const requestIdFactory = vi.fn(() => "generated-request-id");
    const log = vi.fn<StructuredLogSink>();
    const handler = createRequestHandler({
      config: makeConfig(),
      pipeline,
      log,
      requestIdFactory,
    });

    const propagated = await handler(
      new Request(`${TEST_URL}/healthz`, {
        headers: { "X-Request-ID": "client-id:123" },
      }),
    );
    const generated = await handler(
      new Request(`${TEST_URL}/healthz`, {
        headers: { "X-Request-ID": "invalid/id" },
      }),
    );

    expect(propagated.headers.get("X-Request-ID")).toBe("client-id:123");
    expect(generated.headers.get("X-Request-ID")).toBe("generated-request-id");
    expect(requestIdFactory).toHaveBeenCalledOnce();
    expect(log.mock.calls[0]?.[0]).toMatchObject({
      requestId: "client-id:123",
    });
    expect(log.mock.calls[1]?.[0]).toMatchObject({
      requestId: "generated-request-id",
    });
  });
});
