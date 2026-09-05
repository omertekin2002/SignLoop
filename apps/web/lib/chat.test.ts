import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createOpenAiCompatibleClient: vi.fn(),
  extractResponseOutputText: vi.fn(),
  prepareMessagesWithGeminiWebSearch: vi.fn(),
  resolvePrimaryModel: vi.fn(),
  runWithPrimaryAndOpenRouterFallback: vi.fn(),
}));

vi.mock("@/lib/gemini-search", () => ({
  prepareMessagesWithGeminiWebSearch: mocks.prepareMessagesWithGeminiWebSearch,
}));

vi.mock("@/lib/llm-client", () => ({
  APP_NAME: "SignLoop",
  OPENROUTER_API_KEY: "openrouter-key",
  OPENROUTER_BASE_URL: "https://openrouter.test/api/v1",
  OPENROUTER_MODELS: ["fallback/model"],
  PRIMARY_LLM_API_KEY: "primary-key",
  PRIMARY_LLM_BASE_URL: "https://primary.test/v1",
  SITE_URL: "https://signloop.test",
  createOpenAiCompatibleClient: mocks.createOpenAiCompatibleClient,
  extractResponseOutputText: mocks.extractResponseOutputText,
  resolvePrimaryModel: mocks.resolvePrimaryModel,
  runWithPrimaryAndOpenRouterFallback:
    mocks.runWithPrimaryAndOpenRouterFallback,
}));

import {
  generateChatReply,
  generateChatReplyStream,
  type ChatReplyStreamChunk,
  type ChatMessage,
} from "@/lib/chat";
import { buildAuthoritativeUtcTimeContext } from "@/lib/chat-time";

type FakeOpenAiClient = {
  responses: {
    create: ReturnType<typeof vi.fn>;
  };
};

type RunChat = (client: FakeOpenAiClient, model: string) => Promise<string>;

const originalMessages: ChatMessage[] = [
  { role: "system", content: "System prompt" },
  { role: "user", content: "What changed?" },
];
const fixedNow = new Date("2026-07-13T08:15:30.000Z");
const timeAwareMessages: ChatMessage[] = [
  {
    role: "system",
    content: `System prompt\n\n${buildAuthoritativeUtcTimeContext(fixedNow)}`,
  },
  originalMessages[1]!,
];

const searchMetadata = {
  query: "what changed today",
  attemptedQueries: ["what changed today"],
  successfulSearches: 1,
  sources: [
    {
      title: "Current source",
      url: "https://source.example/current",
      snippet: "Current evidence",
    },
  ],
};

const preparedMessages: ChatMessage[] = [
  timeAwareMessages[0]!,
  {
    role: "user",
    content:
      "What changed?\n\nBEGIN_APPLICATION_WEB_RESEARCH_JSON\nCurrent evidence\nEND_APPLICATION_WEB_RESEARCH_JSON",
  },
];

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(fixedNow);
  vi.resetAllMocks();
  mocks.resolvePrimaryModel.mockImplementation(
    (model: string | null | undefined) => model === null ? null : model?.trim() || "default/model",
  );
  mocks.extractResponseOutputText.mockImplementation(
    (response: { output_text?: unknown }) =>
      typeof response.output_text === "string"
        ? response.output_text.trim() || null
        : null,
  );
  mocks.prepareMessagesWithGeminiWebSearch.mockResolvedValue({
    messages: preparedMessages,
    webSearch: searchMetadata,
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("generateChatReply", () => {
  it("gives every model authoritative current time when search is disabled", async () => {
    const create = vi.fn().mockResolvedValue({ status: "completed", output_text: "Plain answer" });
    const client = { responses: { create } };
    mocks.runWithPrimaryAndOpenRouterFallback.mockImplementation(
      async (selectedModel: string, run: RunChat) => ({
        result: await run(client, selectedModel),
        provider: "primary-openai-compatible",
        model: selectedModel,
      }),
    );

    const reply = await generateChatReply(originalMessages, {
      primaryModel: "arbitrary/model",
      enableWebSearch: false,
    });

    expect(mocks.prepareMessagesWithGeminiWebSearch).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledOnce();
    expect(create.mock.calls[0]?.[0]).toMatchObject({
      model: "arbitrary/model",
      input: timeAwareMessages,
    });
    expect(timeAwareMessages[0]?.content).toContain(
      "Current UTC timestamp: 2026-07-13T08:15:30.000Z",
    );
    expect(timeAwareMessages[0]?.content).toContain(
      "dates before 2026-07-13 are in the past",
    );
    expect(originalMessages[0]?.content).toBe("System prompt");
    expect(reply).toEqual({
      message: "Plain answer",
      provider: "primary-openai-compatible",
      model: "arbitrary/model",
      webSearch: null,
    });
  });

  it("gives any model Gemini-grounded evidence without native provider tools", async () => {
    const controller = new AbortController();
    const create = vi.fn().mockResolvedValue({
      status: "completed",
      output_text: "Answer written by the selected model",
    });
    const client = { responses: { create } };
    mocks.runWithPrimaryAndOpenRouterFallback.mockImplementation(
      async (selectedModel: string, run: RunChat) => ({
        result: await run(client, selectedModel),
        provider: "primary-openai-compatible",
        model: selectedModel,
      }),
    );

    const reply = await generateChatReply(originalMessages, {
      primaryModel: "anthropic/claude-without-native-search",
      enableWebSearch: true,
      signal: controller.signal,
    });

    expect(mocks.prepareMessagesWithGeminiWebSearch).toHaveBeenCalledWith(
      timeAwareMessages,
      { signal: controller.signal, currentTime: fixedNow },
    );
    const providerRequest = create.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(providerRequest.input).toEqual(preparedMessages);
    expect(providerRequest).not.toHaveProperty("tools");
    expect(create.mock.calls[0]?.[1]).toEqual({ signal: controller.signal });
    expect(reply.message).toBe("Answer written by the selected model");
    expect(reply.webSearch).toEqual(searchMetadata);
  });

  it("prepends trusted time context when no system message exists", async () => {
    const create = vi.fn().mockResolvedValue({ status: "completed", output_text: "Timed answer" });
    const client = { responses: { create } };
    mocks.runWithPrimaryAndOpenRouterFallback.mockImplementation(
      async (selectedModel: string, run: RunChat) => ({
        result: await run(client, selectedModel),
        provider: "primary-openai-compatible",
        model: selectedModel,
      }),
    );
    const userOnlyMessages: ChatMessage[] = [
      {
        role: "user",
        content: "Was July 10, 2026 in the past on July 13, 2026?",
      },
    ];

    await generateChatReply(userOnlyMessages, {
      primaryModel: "arbitrary/free-model",
    });

    const providerInput = create.mock.calls[0]?.[0]?.input as ChatMessage[];
    expect(providerInput[0]).toMatchObject({ role: "system" });
    expect(providerInput[0]?.content).toContain(
      "Current UTC calendar date: 2026-07-13",
    );
    expect(providerInput[1]).toEqual(userOnlyMessages[0]);
    expect(userOnlyMessages).toEqual([
      {
        role: "user",
        content: "Was July 10, 2026 in the past on July 13, 2026?",
      },
    ]);
  });

  it("searches once and reuses the evidence across an OpenRouter fallback", async () => {
    const primaryCreate = vi.fn().mockRejectedValue(new Error("primary down"));
    const fallbackCreate = vi
      .fn()
      .mockResolvedValue({ status: "completed", output_text: "Fallback answer" });
    const primaryClient = { responses: { create: primaryCreate } };
    const fallbackClient = { responses: { create: fallbackCreate } };

    mocks.runWithPrimaryAndOpenRouterFallback.mockImplementation(
      async (selectedModel: string, run: RunChat) => {
        await expect(run(primaryClient, selectedModel)).rejects.toThrow(
          "primary down",
        );
        return {
          result: await run(fallbackClient, "fallback/model"),
          provider: "openrouter",
          model: "fallback/model",
        };
      },
    );

    const reply = await generateChatReply(originalMessages, {
      primaryModel: "primary/model",
      enableWebSearch: true,
    });

    expect(mocks.prepareMessagesWithGeminiWebSearch).toHaveBeenCalledOnce();
    expect(primaryCreate.mock.calls[0]?.[0]?.input).toEqual(preparedMessages);
    expect(fallbackCreate.mock.calls[0]?.[0]?.input).toEqual(preparedMessages);
    expect(reply).toMatchObject({
      message: "Fallback answer",
      provider: "openrouter",
      model: "fallback/model",
      webSearch: searchMetadata,
    });
  });

  it("does not start any model when the requested web search fails", async () => {
    mocks.prepareMessagesWithGeminiWebSearch.mockRejectedValue(
      new Error("Gemini search unavailable"),
    );

    await expect(
      generateChatReply(originalMessages, {
        primaryModel: "primary/model",
        enableWebSearch: true,
      }),
    ).rejects.toThrow("Gemini search unavailable");

    expect(mocks.runWithPrimaryAndOpenRouterFallback).not.toHaveBeenCalled();
  });
});

describe("generateChatReplyStream", () => {
  it.each(["primary", "fallback"])("rejects %s EOF after deltas without persisting a completed reply", async (provider) => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    async function* incomplete() { yield { type: "response.output_text.delta", delta: "Partial" }; }
    mocks.createOpenAiCompatibleClient.mockReturnValue({ responses: { create: provider === "primary" ? vi.fn().mockResolvedValue(incomplete()) : vi.fn().mockRejectedValue(new Error("offline")) } });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response('data: {"type":"response.output_text.delta","delta":"Partial"}\n\n')));
    const chunks: ChatReplyStreamChunk[] = [];
    await expect((async () => {
      for await (const chunk of generateChatReplyStream(originalMessages)) chunks.push(chunk);
    })()).rejects.toThrow(/before successful completion/);
    expect(chunks).toEqual([{ type: "delta", text: "Partial" }]);
  });

  it("skips primary when availability explicitly resolves to null", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response('data: {"type":"response.completed","response":{"status":"completed","output_text":"Fallback"}}\n\n')));
    const chunks: ChatReplyStreamChunk[] = [];
    for await (const chunk of generateChatReplyStream(originalMessages, { primaryModel: null })) chunks.push(chunk);
    expect(mocks.createOpenAiCompatibleClient).not.toHaveBeenCalled();
    expect(chunks.at(-1)).toMatchObject({ type: "done", reply: { provider: "openrouter" } });
  });
  it("preserves token streaming and attaches Gemini metadata for any primary model", async () => {
    async function* responseStream() {
      yield { type: "response.output_text.delta", delta: "Live " };
      yield { type: "response.output_text.delta", delta: "answer" };
      yield { type: "response.output_text.done", text: "Live answer" };
      yield { type: "response.completed", response: { status: "completed", output_text: "Live answer" } };
    }

    const create = vi.fn().mockResolvedValue(responseStream());
    mocks.createOpenAiCompatibleClient.mockReturnValue({
      responses: { create },
    });

    const chunks: ChatReplyStreamChunk[] = [];
    for await (const chunk of generateChatReplyStream(originalMessages, {
      primaryModel: "arbitrary/non-native-model",
      enableWebSearch: true,
    })) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual([
      { type: "delta", text: "Live " },
      { type: "delta", text: "answer" },
      {
        type: "done",
        reply: {
          message: "Live answer",
          provider: "primary-openai-compatible",
          model: "arbitrary/non-native-model",
          webSearch: searchMetadata,
        },
      },
    ]);
    expect(create.mock.calls[0]?.[0]).toMatchObject({
      input: preparedMessages,
      stream: true,
    });
    expect(create.mock.calls[0]?.[0]).not.toHaveProperty("tools");
    expect(mocks.prepareMessagesWithGeminiWebSearch).toHaveBeenCalledOnce();
  });

  it("reuses Gemini evidence and metadata in a streaming OpenRouter fallback", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const primaryCreate = vi
      .fn()
      .mockRejectedValue(new Error("primary unavailable"));
    mocks.createOpenAiCompatibleClient.mockReturnValue({
      responses: { create: primaryCreate },
    });

    const openRouterEvents = [
      'data: {"type":"response.output_text.delta","delta":"Fallback "}\n\n',
      'data: {"type":"response.output_text.delta","delta":"answer"}\n\n',
      'data: {"type":"response.output_text.done","text":"Fallback answer"}\n\n',
      'data: {"type":"response.completed","response":{"status":"completed","output_text":"Fallback answer"}}\n\n',
      "data: [DONE]\n\n",
    ].join("");
    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        new Response(openRouterEvents, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const chunks: ChatReplyStreamChunk[] = [];
    for await (const chunk of generateChatReplyStream(originalMessages, {
      primaryModel: "primary/model",
      enableWebSearch: true,
    })) {
      chunks.push(chunk);
    }

    expect(mocks.prepareMessagesWithGeminiWebSearch).toHaveBeenCalledOnce();
    expect(chunks.at(-1)).toEqual({
      type: "done",
      reply: {
        message: "Fallback answer",
        provider: "openrouter",
        model: "fallback/model",
        webSearch: searchMetadata,
      },
    });

    const openRouterBody = JSON.parse(
      String(fetchMock.mock.calls[0]?.[1]?.body),
    ) as { input: ChatMessage[] };
    expect(openRouterBody.input).toEqual(preparedMessages);
  });
});
