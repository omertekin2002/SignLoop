// Ported from SignLoop at 61c90b508a789cee988acdded52b2d1a8c82ee69.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MockLanguageModelV4 } from "ai/test";
import {
  FIRST_CHUNK_TIMEOUT_MS,
  GEMINI_FIRST_CHUNK_TIMEOUT_MS,
  openingDeadlineMs,
} from "../src/pipeline/agent-provider";
import { simulateReadableStream } from "ai";

const mocks = vi.hoisted(() => ({
  search: vi.fn(),
  responses: vi.fn(),
  gemini: vi.fn(),
  readUrl: vi.fn(),
  httpGet: vi.fn(),
  generateImage: vi.fn(),
}));
vi.mock("@ai-sdk/openai", () => ({
  createOpenAI: () => ({ responses: mocks.responses }),
}));
vi.mock("@ai-sdk/google", () => ({
  createGoogleGenerativeAI: () => ({ languageModel: mocks.gemini }),
}));
vi.mock("../src/pipeline/web-search", () => ({ searchWeb: mocks.search }));
vi.mock("../src/pipeline/url-reader", () => ({ readUrl: mocks.readUrl }));
vi.mock("../src/pipeline/http-fetch", () => ({ httpGet: mocks.httpGet }));
vi.mock("../src/pipeline/image-generation", () => ({
  generateImageReply: mocks.generateImage,
}));
import {
  createRoutedModel,
  generateChatReply as generateReply,
  generateChatReplyStream as generateReplyStream,
  type ChatReplyStreamChunk,
  type ChatGenerationOptions,
  type ChatMessage,
} from "../src/pipeline/chat";
import {
  compactAgentMessages,
  MAX_SOURCE_CATALOG_CHARACTERS,
  MAX_SOURCE_COUNT,
} from "../src/pipeline/chat-agent-history";

const usage = {
  inputTokens: {
    total: 1,
    noCache: 1,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};
function streamStep(
  index: number,
  query?: string,
  finishReason = query ? "tool-calls" : "stop",
) {
  return {
    stream: simulateReadableStream({
      initialDelayInMs: null,
      chunkDelayInMs: null,
      chunks: [
        ...(query
          ? [
              {
                type: "tool-call",
                toolCallId: `call-${index}`,
                toolName: "search_web",
                input: JSON.stringify({ query }),
              },
            ]
          : [
              { type: "text-start", id: "text" },
              { type: "text-delta", id: "text", delta: "Answer [1]" },
              { type: "text-end", id: "text" },
            ]),
        {
          type: "finish",
          finishReason: { unified: finishReason, raw: undefined },
          usage,
        },
      ],
    }),
  };
}
function toolStep(
  index: number,
  toolName: string,
  input: Record<string, unknown>,
) {
  return {
    stream: simulateReadableStream({
      initialDelayInMs: null,
      chunkDelayInMs: null,
      chunks: [
        {
          type: "tool-call",
          toolCallId: `call-${index}`,
          toolName,
          input: JSON.stringify(input),
        },
        {
          type: "finish",
          finishReason: { unified: "tool-calls", raw: undefined },
          usage,
        },
      ],
    }),
  };
}
type StepResult = Awaited<ReturnType<MockLanguageModelV4["doStream"]>>;
function sequencedModel(steps: Array<ReturnType<typeof toolStep>>) {
  const queue = [...steps];
  return new MockLanguageModelV4({
    doStream: async () => (queue.shift() ?? streamStep(99)) as StepResult,
  });
}
function scriptedModel(queries: string[] = []) {
  let index = 0;
  const model = new MockLanguageModelV4({
    doStream: async () =>
      streamStep(index, queries[index++]) as Awaited<
        ReturnType<MockLanguageModelV4["doStream"]>
      >,
  });
  return model;
}
beforeEach(() => {
  vi.resetAllMocks();
  mocks.search.mockImplementation(async (query: string) => ({
    provider: "brave",
    query,
    brief: null,
    results: [
      {
        title: "Source",
        url: "https://source.test",
        snippet: `Evidence for ${query}`,
      },
    ],
  }));
});
afterEach(() => {
  vi.restoreAllMocks();
});
const messages = [{ role: "user" as const, content: "Wazzup" }];

describe("agentic chat", () => {
  it("lets the model answer a greeting without any search or classifier call", async () => {
    const model = scriptedModel();
    mocks.responses.mockReturnValue(model);
    const reply = await generateChatReply(messages, { enableWebSearch: true });
    expect(mocks.search).not.toHaveBeenCalled();
    expect(model.doStreamCalls).toHaveLength(1);
    expect(model.doStreamCalls[0]?.tools).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "search_web" })]),
    );
    expect(reply.webSearch).toBeNull();
    expect(reply.agentMessages).toBeUndefined();
  });

  it("uses complete canonical text instead of legacy clipped text-only replay", async () => {
    const model = scriptedModel();
    mocks.responses.mockReturnValue(model);
    const answer = `${"x".repeat(3000)} The renewal deadline is September 30.`;
    await generateChatReply([
      { role: "user", content: "Explain the renewal terms." },
      {
        role: "assistant",
        content: answer,
        agentMessages: [
          {
            role: "assistant",
            content: [
              {
                type: "text",
                text: `${answer.slice(0, 2000)}\n[Replay excerpt]`,
              },
            ],
          },
        ],
      },
      { role: "user", content: "What was that deadline?" },
    ]);

    const assistant = model.doStreamCalls[0]?.prompt.find(
      (message) => message.role === "assistant",
    );
    expect(assistant?.content).toEqual([
      { type: "text", text: answer, providerOptions: undefined },
    ]);
  });

  it.each([false, true])(
    "keeps the full canonical answer after tool replay (legacy=%s)",
    async (legacy) => {
      const answer = `${"x".repeat(2500)} The renewal deadline is September 30.`;
      const transcript = [
        {
          role: "assistant",
          content: [
            { type: "text", text: "Old clipped commentary" },
            {
              type: "tool-call",
              toolCallId: "c1",
              toolName: "read_url",
              input: { url: "https://law.test" },
            },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "c1",
              toolName: "read_url",
              output: { type: "text", value: "Source evidence" },
            },
          ],
        },
        { role: "assistant", content: answer.slice(0, 2000) },
      ] as const;
      const replay = compactAgentMessages(transcript);
      const model = scriptedModel();
      mocks.responses.mockReturnValue(model);
      await generateChatReply([
        { role: "user", content: "Explain the renewal." },
        {
          role: "assistant",
          content: answer,
          agentMessages: legacy
            ? JSON.parse(JSON.stringify(transcript))
            : replay,
        },
        { role: "user", content: "What was that deadline?" },
      ]);
      const prompt = model.doStreamCalls[0]!.prompt;
      const serialized = JSON.stringify(prompt);
      expect(serialized.match(/September 30/g)).toHaveLength(1);
      expect(serialized).toContain("Source evidence");
      expect(serialized).not.toContain("Old clipped commentary");
      expect(prompt.filter((message) => message.role === "tool")).toHaveLength(
        1,
      );
      // Tool exchange first, then the complete canonical answer, then the new question.
      expect(prompt.slice(-3).map((message) => message.role)).toEqual([
        "tool",
        "assistant",
        "user",
      ]);
      expect(prompt.at(-2)?.content).toEqual([
        { type: "text", text: answer, providerOptions: undefined },
      ]);
    },
  );

  it("executes successive model-selected searches and returns results to the model", async () => {
    const model = scriptedModel(["first query", "refined query"]);
    mocks.responses.mockReturnValue(model);
    const chunks: ChatReplyStreamChunk[] = [];
    for await (const chunk of generateChatReplyStream(messages, {
      enableWebSearch: true,
    }))
      chunks.push(chunk);
    expect(mocks.search.mock.calls.map((call) => call[0])).toEqual([
      "first query",
      "refined query",
    ]);
    expect(model.doStreamCalls).toHaveLength(3);
    expect(JSON.stringify(model.doStreamCalls[1]?.prompt)).toContain(
      "Evidence for first query",
    );
    expect(JSON.stringify(model.doStreamCalls[2]?.prompt)).toContain(
      "Evidence for refined query",
    );
    expect(chunks.filter((chunk) => chunk.type === "tool")).toHaveLength(4);
    const done = chunks.at(-1);
    expect(done?.type).toBe("done");
    if (done?.type === "done") {
      // Search returns leads, so nothing is citable until a page is actually read.
      expect(done.reply.webSearch).toBeNull();
      expect(
        done.reply.agentMessages?.some((message) => message.role === "tool"),
      ).toBe(true);
      expect(
        done.reply.toolActivity?.every(
          (activity) => activity.status === "complete",
        ),
      ).toBe(true);
    }
  });

  it("does not expose search when the session lacks access", async () => {
    const model = scriptedModel();
    mocks.responses.mockReturnValue(model);
    await generateChatReply(messages);
    expect(model.doStreamCalls[0]?.tools ?? []).toHaveLength(0);
    expect(mocks.search).not.toHaveBeenCalled();
  });

  it("deduplicates repeated queries and bounds total search executions", async () => {
    const model = scriptedModel(["A", "a", "B", "C", "D", "E", "F", "G", "H"]);
    mocks.responses.mockReturnValue(model);
    await generateChatReply(messages, { enableWebSearch: true });
    expect(mocks.search.mock.calls.map((call) => call[0])).toEqual([
      "A",
      "B",
      "C",
    ]);
    // Ten steps: nine tool rounds, then the final step is forced to answer without tools.
    expect(model.doStreamCalls).toHaveLength(10);
    expect(model.doStreamCalls[9]?.toolChoice).toEqual({ type: "none" });
    expect(JSON.stringify(model.doStreamCalls[9]?.prompt)).toContain(
      "budget exhausted",
    );
  });

  it("returns search errors to the model without inventing evidence", async () => {
    const model = scriptedModel(["query"]);
    mocks.responses.mockReturnValue(model);
    mocks.search.mockRejectedValue(new Error("secret internal error"));
    const reply = await generateChatReply(messages, { enableWebSearch: true });
    expect(reply.toolActivity?.[0]?.status).toBe("error");
    expect(reply.webSearch).toBeNull();
    expect(JSON.stringify(model.doStreamCalls[1]?.prompt)).toContain(
      "Web search failed",
    );
    expect(JSON.stringify(model.doStreamCalls[1]?.prompt)).not.toContain(
      "secret internal error",
    );
  });

  it("preserves completed tool results when the next model step needs fallback", async () => {
    let calls = 0;
    const primary = new MockLanguageModelV4({
      doStream: async () => {
        if (calls++) throw new Error("unavailable");
        return streamStep(0, "query") as Awaited<
          ReturnType<MockLanguageModelV4["doStream"]>
        >;
      },
    });
    const fallback = scriptedModel();
    mocks.responses.mockImplementation((model: string) =>
      model === "primary" ? primary : fallback,
    );
    const reply = await generateChatReply(messages, { enableWebSearch: true });
    expect(reply.provider).toBe("openrouter");
    expect(mocks.search).toHaveBeenCalledOnce();
    expect(JSON.stringify(fallback.doStreamCalls[0]?.prompt)).toContain(
      "Evidence for query",
    );
  });

  it("replays saved tool exchanges on the next user turn", async () => {
    mocks.responses.mockReturnValue(scriptedModel(["query"]));
    const first = await generateChatReply(messages, { enableWebSearch: true });
    const next = scriptedModel();
    mocks.responses.mockReturnValue(next);
    const nextReply = await generateChatReply(
      [
        ...messages,
        {
          role: "assistant",
          content: first.message,
          agentMessages: first.agentMessages,
          webSources: first.webSearch?.sources,
        },
        { role: "user", content: "Explain that source" },
      ],
      { enableWebSearch: true },
    );
    expect(JSON.stringify(next.doStreamCalls[0]?.prompt)).toContain(
      "Evidence for query",
    );
    expect(first.webSearch).toBeNull();
    expect(nextReply.webSearch).toBeNull();
  });

  it("makes a searched page citable only after it is read", async () => {
    mocks.readUrl.mockResolvedValue({
      title: "Source",
      url: "https://source.test",
      content: "Supported fact",
      truncated: false,
      provider: "jina",
    });
    const model = sequencedModel([
      toolStep(0, "search_web", { query: "isctr close" }),
      toolStep(1, "read_url", { url: "https://source.test" }),
    ]);
    mocks.responses.mockReturnValue(model);
    const reply = await generateChatReply(messages, {
      enableWebSearch: true,
      enableUrlReader: true,
    });
    // One source, contributed by the read rather than by the eight-result search.
    expect(reply.webSearch?.sources).toEqual([
      { number: 1, title: "Source", url: "https://source.test" },
    ]);
  });

  it("includes authoritative time and the selected personality without mutating input", async () => {
    const model = scriptedModel();
    mocks.responses.mockReturnValue(model);
    const input = [
      { role: "system" as const, content: "Bare LLM personality" },
      ...messages,
    ];
    await generateChatReply(input);
    expect(JSON.stringify(model.doStreamCalls[0]?.prompt)).toContain(
      "Current UTC timestamp:",
    );
    expect(JSON.stringify(model.doStreamCalls[0]?.prompt)).toContain(
      "Bare LLM personality",
    );
    expect(input[0]?.content).toBe("Bare LLM personality");
  });

  it("does not restart on fallback after a partial stream fails", async () => {
    const primary = new MockLanguageModelV4({
      doStream: async () => ({
        stream: simulateReadableStream({
          initialDelayInMs: null,
          chunkDelayInMs: null,
          chunks: [
            { type: "text-start", id: "text" },
            { type: "text-delta", id: "text", delta: "Partial answer" },
            { type: "error", error: new Error("stream broke") },
          ],
        }),
      }),
    });
    const fallback = scriptedModel();
    mocks.responses.mockImplementation((name: string) =>
      name === "primary" ? primary : fallback,
    );
    await expect(generateChatReply(messages)).rejects.toThrow("stream broke");
    expect(fallback.doStreamCalls).toHaveLength(0);
  });

  it("rejects incomplete output instead of persisting it", async () => {
    mocks.responses.mockReturnValue(
      new MockLanguageModelV4({
        doStream: async () =>
          streamStep(0, undefined, "length") as Awaited<
            ReturnType<MockLanguageModelV4["doStream"]>
          >,
      }),
    );
    await expect(generateChatReply(messages)).rejects.toThrow(
      /did not complete/,
    );
  });

  it("cancels the active run when the consumer stops reading", async () => {
    const model = scriptedModel(["query"]);
    mocks.responses.mockReturnValue(model);
    const iterator = generateChatReplyStream(messages, {
      enableWebSearch: true,
    });
    await iterator.next();
    await iterator.return();
    expect(model.doStreamCalls[0]?.abortSignal?.aborted).toBe(true);
  });

  it("fails over when the primary accepts the request but never starts a stream", async () => {
    const primary = new MockLanguageModelV4({
      doStream: () => new Promise(() => {}),
    });
    const fallback = scriptedModel();
    mocks.responses.mockImplementation((name: string) =>
      name === "primary" ? primary : fallback,
    );
    const reply = await generateChatReply(messages, {
      firstChunkTimeoutMs: 20,
    });
    expect(reply.provider).toBe("openrouter");
    expect(reply.message).toBe("Answer [1]");
    expect(primary.doStreamCalls[0]?.abortSignal?.aborted).toBe(true);
  });

  it("fails over when the primary opens a stream that never delivers content", async () => {
    const primary = new MockLanguageModelV4({
      doStream: async () => ({
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] });
          },
        }),
      }),
    });
    const fallback = scriptedModel();
    mocks.responses.mockImplementation((name: string) =>
      name === "primary" ? primary : fallback,
    );
    const reply = await generateChatReply(messages, {
      firstChunkTimeoutMs: 20,
    });
    expect(reply.provider).toBe("openrouter");
    expect(fallback.doStreamCalls).toHaveLength(1);
  });

  it("surfaces the timeout when every provider stays silent", async () => {
    mocks.responses.mockReturnValue(
      new MockLanguageModelV4({ doStream: () => new Promise(() => {}) }),
    );
    await expect(
      generateChatReply(messages, { firstChunkTimeoutMs: 20 }),
    ).rejects.toThrow(/generation providers are unavailable/);
  });

  it("falls back for non-streaming generation as well", async () => {
    const primary = new MockLanguageModelV4({
      doGenerate: async () => {
        throw new Error("primary down");
      },
    });
    const fallback = new MockLanguageModelV4({
      doGenerate: async () => ({
        content: [{ type: "text", text: "from fallback" }],
        finishReason: { unified: "stop", raw: undefined },
        usage,
        warnings: [],
      }),
    });
    mocks.responses.mockImplementation((name: string) =>
      name === "primary" ? primary : fallback,
    );
    const routed = createRoutedModel(baseOptions.providerConfig);
    const result = await routed.model.doGenerate({ prompt: [] });
    expect(result.content).toEqual([{ type: "text", text: "from fallback" }]);
    expect(routed.selected().provider).toBe("openrouter");
    expect(primary.doGenerateCalls).toHaveLength(1);
  });

  it("reads a page on request and numbers it as a citable source", async () => {
    mocks.readUrl.mockResolvedValue({
      title: "Statute",
      url: "https://law.test/statute",
      content: "Section 1. Text of the statute.",
      truncated: false,
      provider: "jina",
    });
    const model = sequencedModel([
      toolStep(0, "read_url", { url: "https://law.test/statute" }),
    ]);
    mocks.responses.mockReturnValue(model);
    const reply = await generateChatReply(messages, { enableUrlReader: true });
    expect(mocks.readUrl).toHaveBeenCalledWith(
      "https://law.test/statute",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(reply.webSearch?.sources).toEqual([
      { number: 1, title: "Statute", url: "https://law.test/statute" },
    ]);
    const continuation = JSON.stringify(model.doStreamCalls[1]?.prompt);
    expect(continuation).toContain("UNTRUSTED CONTENT");
    expect(continuation).toContain("Text of the statute");
    expect(reply.toolActivity).toEqual([
      {
        id: "call-0",
        tool: "read_url",
        query: "https://law.test/statute",
        status: "complete",
      },
    ]);
    expect(JSON.stringify(model.doStreamCalls[0]?.prompt)).toContain(
      "read_url",
    );
  });

  it("streams a generated image into the reply without putting bytes in the transcript", async () => {
    const markdown = "![Generated image](data:image/png;base64,AAAA)";
    mocks.generateImage.mockResolvedValue({
      message: markdown,
      model: "gpt-image-2.5-sunburst",
      provider: "primary-openai-compatible",
    });
    const model = sequencedModel([
      toolStep(0, "generate_image", { prompt: "a signed contract on a desk" }),
    ]);
    mocks.responses.mockReturnValue(model);
    const chunks: ChatReplyStreamChunk[] = [];
    for await (const chunk of generateChatReplyStream(messages, {
      enableImageGeneration: true,
    }))
      chunks.push(chunk);
    expect(mocks.generateImage).toHaveBeenCalledWith(
      "a signed contract on a desk",
      expect.objectContaining({
        model: "gpt-image-2.5-sunburst",
        providerConfig: baseOptions.providerConfig,
      }),
    );
    const deltas = chunks
      .filter((chunk) => chunk.type === "delta")
      .map((chunk) => chunk.text);
    expect(deltas[0]).toBe(markdown);
    const done = chunks.at(-1);
    if (done?.type !== "done") throw new Error("missing done");
    expect(done.reply.message).toBe(`${markdown}\n\nAnswer [1]`);
    expect(JSON.stringify(done.reply.agentMessages)).not.toContain("base64");
    expect(JSON.stringify(model.doStreamCalls[1]?.prompt)).toContain(
      '"attached"',
    );
    expect(done.reply.toolActivity).toEqual([
      {
        id: "call-0",
        tool: "generate_image",
        query: "a signed contract on a desk",
        status: "complete",
      },
    ]);

    const withoutImages = scriptedModel();
    mocks.responses.mockReturnValue(withoutImages);
    await generateChatReply(messages, { enableWebSearch: true });
    expect(
      withoutImages.doStreamCalls[0]?.tools?.map((item) => item.name),
    ).toEqual(["search_web", "read_url", "http_get"]);
  });

  it("returns image failures to the model as tool errors", async () => {
    mocks.generateImage.mockRejectedValue(
      new Error("upstream 500 with secret details"),
    );
    vi.spyOn(console, "error").mockImplementation(() => {});
    const model = sequencedModel([
      toolStep(0, "generate_image", { prompt: "anything" }),
    ]);
    mocks.responses.mockReturnValue(model);
    const reply = await generateChatReply(messages, {
      enableImageGeneration: true,
    });
    expect(reply.message).toBe("Answer [1]");
    expect(reply.toolActivity?.[0]?.status).toBe("error");
    const continuation = JSON.stringify(model.doStreamCalls[1]?.prompt);
    expect(continuation).toContain("Image generation failed");
    expect(continuation).not.toContain("secret details");
  });

  it("supports an OpenRouter-only configuration", async () => {
    mocks.responses.mockReturnValue(scriptedModel());
    const reply = await generateReply(messages, {
      ...baseOptions,
      providerConfig: { ...baseOptions.providerConfig, primary: undefined },
    });
    expect(mocks.responses.mock.calls.map((call) => call[0])).toEqual([
      "fallback",
    ]);
    expect(reply).toMatchObject({ provider: "openrouter", model: "fallback" });
  });
});

const baseOptions: ChatGenerationOptions = {
  providerConfig: {
    primary: {
      baseURL: "https://primary.test/v1",
      apiKey: "test",
      model: "primary",
    },
    openRouter: {
      baseURL: "https://fallback.test/v1",
      apiKey: "test",
      models: ["fallback"],
    },
    publicServiceUrl: "https://service.test",
    appName: "Test gateway",
  },
  dependencies: { discoverModel: async () => "available" },
};
type UpstreamTestOptions = {
  enableWebSearch?: boolean;
  enableUrlReader?: boolean;
  enableImageGeneration?: boolean;
  firstChunkTimeoutMs?: number;
};
function optionsFor(options: UpstreamTestOptions = {}): ChatGenerationOptions {
  return {
    ...baseOptions,
    researchMode:
      options.enableWebSearch || options.enableUrlReader ? "auto" : "never",
    imageGeneration: {
      enabled: options.enableImageGeneration ?? false,
      model: "gpt-image-2.5-sunburst",
    },
    firstChunkTimeoutMs: options.firstChunkTimeoutMs,
  };
}
const generateChatReply = (
  messages: readonly ChatMessage[],
  options?: UpstreamTestOptions,
) => generateReply(messages, optionsFor(options));
const generateChatReplyStream = (
  messages: readonly ChatMessage[],
  options?: UpstreamTestOptions,
) => generateReplyStream(messages, optionsFor(options));

it("auto exposes public research tools even for prompts without English keywords", async () => {
  const model = scriptedModel();
  mocks.responses.mockReturnValue(model);
  await generateReply(
    [{ role: "user", content: "Bugün İstanbul’da hava nasıl?" }],
    baseOptions,
  );
  expect(model.doStreamCalls[0]?.tools?.map((tool) => tool.name)).toEqual([
    "search_web",
    "read_url",
    "http_get",
  ]);
  expect(mocks.search).not.toHaveBeenCalled();
});

it("strict research rejects search-only answers without emitting answer deltas", async () => {
  mocks.responses.mockReturnValue(scriptedModel(["fresh query"]));
  const chunks: ChatReplyStreamChunk[] = [];
  await expect(
    (async () => {
      for await (const chunk of generateReplyStream(messages, {
        ...baseOptions,
        researchMode: "always",
      }))
        chunks.push(chunk);
    })(),
  ).rejects.toMatchObject({ name: "ResearchUnavailableError" });
  expect(chunks.some((chunk) => chunk.type === "tool")).toBe(true);
  expect(
    chunks.some((chunk) => chunk.type === "delta" || chunk.type === "done"),
  ).toBe(false);
});

it("strict research accepts fresh page text and preserves tool history", async () => {
  mocks.readUrl.mockResolvedValue({
    title: "Fresh page",
    url: "https://source.test/new",
    content: "Fresh source text",
    truncated: false,
    provider: "jina",
  });
  const model = sequencedModel([
    toolStep(0, "read_url", { url: "https://source.test/new" }),
  ]);
  mocks.responses.mockReturnValue(model);
  const chunks: ChatReplyStreamChunk[] = [];
  for await (const chunk of generateReplyStream(messages, {
    ...baseOptions,
    researchMode: "always",
  }))
    chunks.push(chunk);
  expect(model.doStreamCalls[0]?.toolChoice).toEqual({ type: "required" });
  expect(model.doStreamCalls[1]?.toolChoice).toEqual({ type: "auto" });
  expect(chunks.map((chunk) => chunk.type)).toEqual([
    "tool",
    "tool",
    "delta",
    "done",
  ]);
  const done = chunks.at(-1);
  if (done?.type !== "done") throw new Error("missing done");
  expect(done.reply.readSources).toEqual([1]);
  expect(
    done.reply.agentMessages?.some((message) => message.role === "tool"),
  ).toBe(true);
});

it("strict research cannot be satisfied by a retained source catalog", async () => {
  mocks.responses.mockReturnValue(scriptedModel());
  await expect(
    generateReply(
      [
        { role: "user", content: "Earlier question" },
        {
          role: "assistant",
          content: "Earlier answer [1]",
          webSources: [{ title: "Old", url: "https://old.test/" }],
        },
        { role: "user", content: "Check it again" },
      ],
      { ...baseOptions, researchMode: "always" },
    ),
  ).rejects.toMatchObject({ name: "ResearchUnavailableError" });
});

it("keeps prior source numbers stable when another page is read", async () => {
  mocks.readUrl.mockResolvedValue({
    title: "New",
    url: "https://new.test/",
    content: "Evidence",
    provider: "jina",
    truncated: false,
  });
  mocks.responses.mockReturnValue(
    sequencedModel([toolStep(0, "read_url", { url: "https://new.test/" })]),
  );
  const reply = await generateReply(
    [
      {
        role: "assistant",
        content: "Old answer [1]",
        webSources: [{ title: "Old", url: "https://old.test/" }],
      },
      ...messages,
    ],
    baseOptions,
  );
  expect(reply.webSearch?.sources.map((source) => source.title)).toEqual([
    "Old",
    "New",
  ]);
  expect(reply.readSources).toEqual([2]);
});

it("retires inherited sources to read new evidence after a full inherited catalog", async () => {
  // A legacy positional catalog: entries carry no explicit numbers.
  const catalog = Array.from({ length: MAX_SOURCE_COUNT }, (_, index) => ({
    title: `Source ${index + 1}`,
    url: `https://s${index + 1}.test/`,
  }));
  mocks.readUrl.mockImplementation(async (url: string) => ({
    title: url === "https://s3.test/" ? "Source 3" : "New source",
    url,
    content: "Fresh evidence",
    provider: "jina",
    truncated: false,
  }));
  const model = sequencedModel([
    toolStep(0, "search_web", { query: "more sources" }),
    toolStep(1, "read_url", { url: "https://new.test/" }),
    toolStep(2, "read_url", { url: "https://s3.test/" }),
  ]);
  mocks.responses.mockReturnValue(model);

  const reply = await generateReply(
    [
      {
        role: "assistant",
        content: "Earlier answer [64]",
        webSources: catalog,
      },
      ...messages,
    ],
    baseOptions,
  );

  expect(mocks.search).toHaveBeenCalledOnce();
  expect(mocks.readUrl.mock.calls.map((call) => call[0])).toEqual([
    "https://new.test/",
    "https://s3.test/",
  ]);
  expect(JSON.stringify(model.doStreamCalls[2]?.prompt)).toContain(
    "Fresh evidence",
  );
  expect(
    JSON.stringify(model.doStreamCalls).includes("limit of numbered"),
  ).toBe(false);
  // The new page takes the next unused number; a re-read keeps its original one.
  expect(reply.readSources).toEqual([65, 3]);
  const sources = reply.webSearch!.sources;
  expect(sources).toHaveLength(MAX_SOURCE_COUNT);
  expect(sources[0]).toEqual({
    number: 2,
    title: "Source 2",
    url: "https://s2.test/",
  });
  expect(sources.at(-1)).toEqual({
    number: 65,
    title: "New source",
    url: "https://new.test/",
  });
  expect(sources.some((source) => source.number === 1)).toBe(false);
  expect(catalog[0]).not.toHaveProperty("number");
});

it("strict research can still fetch fresh evidence after a full inherited catalog", async () => {
  const catalog = Array.from({ length: MAX_SOURCE_COUNT }, (_, index) => ({
    number: index + 100,
    title: `Source ${index + 1}`,
    url: `https://s${index + 1}.test/`,
  }));
  mocks.readUrl.mockResolvedValue({
    title: "Fresh page",
    url: "https://fresh.test/",
    content: "Fresh source text",
    provider: "jina",
    truncated: false,
  });
  mocks.responses.mockReturnValue(
    sequencedModel([toolStep(0, "read_url", { url: "https://fresh.test/" })]),
  );
  const chunks: ChatReplyStreamChunk[] = [];
  for await (const chunk of generateReplyStream(
    [
      {
        role: "assistant",
        content: "Earlier answer [100]",
        webSources: catalog,
      },
      ...messages,
    ],
    { ...baseOptions, researchMode: "always" },
  ))
    chunks.push(chunk);
  const done = chunks.at(-1);
  if (done?.type !== "done") throw new Error("missing done");
  // Gapped explicit IDs continue after the highest one.
  expect(done.reply.readSources).toEqual([164]);
  expect(done.reply.webSearch?.sources[0]?.number).toBe(101);
  // Strict mode still releases the answer only after the fresh read succeeded.
  expect(chunks.filter((chunk) => chunk.type === "delta")).toHaveLength(1);
});

const bigPage = (host: string, index: number) => ({
  title: "T".repeat(240),
  url: `https://${host}.test/${index}/${"x".repeat(1900)}`,
});
/** Five page reads and two API reads of near-maximum size: the most this turn can hold. */
function fillCatalogThisTurn(extra: Array<ReturnType<typeof toolStep>>) {
  const reads = [0, 1, 2, 3, 4].map((index) => bigPage("read", index));
  const fetches = [0, 1].map((index) => bigPage("api", index).url);
  mocks.readUrl.mockImplementation(async (url: string) => ({
    ...reads.find((page) => page.url === url)!,
    content: "Fresh evidence",
    provider: "jina",
    truncated: false,
  }));
  mocks.httpGet.mockImplementation(async (url: string) => ({
    url,
    status: 200,
    contentType: "application/json",
    truncated: false,
    body: '{"value":1}',
  }));
  return sequencedModel([
    ...reads.map((page, index) =>
      toolStep(index, "read_url", { url: page.url }),
    ),
    ...fetches.map((url, index) => toolStep(5 + index, "http_get", { url })),
    ...extra,
  ]);
}

it("never evicts this turn's evidence and stops paying for reads it cannot number", async () => {
  const blocked = bigPage("blocked", 0).url;
  const model = fillCatalogThisTurn([
    toolStep(7, "http_get", { url: blocked }),
  ]);
  mocks.responses.mockReturnValue(model);

  const reply = await generateReply(
    [
      {
        role: "assistant",
        content: "Earlier answer [1]",
        webSources: [{ title: "Old", url: "https://old.test/" }],
      },
      ...messages,
    ],
    baseOptions,
  );

  expect(mocks.readUrl).toHaveBeenCalledTimes(5);
  expect(mocks.httpGet.mock.calls.map((call) => call[0])).not.toContain(
    blocked,
  );
  expect(JSON.stringify(model.doStreamCalls[8]?.prompt)).toContain(
    "limit of numbered sources",
  );
  expect(reply.readSources).toEqual([2, 3, 4, 5, 6, 7, 8]);
  const sources = reply.webSearch!.sources;
  expect(sources.map((source) => source.number)).toEqual(
    expect.arrayContaining(reply.readSources!),
  );
  expect(JSON.stringify(sources).length).toBeLessThanOrEqual(
    MAX_SOURCE_CATALOG_CHARACTERS,
  );
});

it("explains a full catalog when a fetched page's title does not fit", async () => {
  // Leave room for the new address with an empty title, but not for its real title.
  const filled = [
    ...[0, 1, 2, 3, 4].map((index) => bigPage("read", index)),
    ...[0, 1].map((index) => {
      const url = bigPage("api", index).url;
      const target = new URL(url);
      return {
        title: `${target.hostname}${target.pathname}`.slice(0, 240),
        url,
      };
    }),
  ].map((page, index) => ({ ...page, number: index + 1 }));
  let newUrl = "https://new.test/";
  const spare =
    MAX_SOURCE_CATALOG_CHARACTERS -
    JSON.stringify([...filled, { title: "", url: newUrl, number: 8 }]).length;
  newUrl += "p".repeat(spare - 5);
  expect(spare - 5).toBeGreaterThan(0);
  expect(newUrl.length).toBeLessThanOrEqual(2048);
  const model = fillCatalogThisTurn([toolStep(7, "http_get", { url: newUrl })]);
  mocks.responses.mockReturnValue(model);

  const reply = await generateReply(messages, baseOptions);

  expect(mocks.httpGet.mock.calls.at(-1)?.[0]).toBe(newUrl);
  expect(JSON.stringify(model.doStreamCalls[8]?.prompt)).toContain(
    "limit of numbered sources",
  );
  expect(reply.readSources).toEqual([1, 2, 3, 4, 5, 6, 7]);
  expect(reply.webSearch?.sources).toEqual(filled);
});

it.each([
  [401, false],
  [503, true],
] as const)(
  "after an OpenRouter %i, trying the next fallback model is %s",
  async (status, continues) => {
    const failing = new MockLanguageModelV4({
      doStream: async () => {
        throw Object.assign(new Error("provider failure"), { status });
      },
    });
    const next = scriptedModel();
    mocks.responses.mockImplementation((model: string) =>
      model === "fallback-two" ? next : failing,
    );
    const run = generateReply(messages, {
      ...baseOptions,
      providerConfig: {
        ...baseOptions.providerConfig,
        openRouter: {
          ...baseOptions.providerConfig.openRouter!,
          models: ["fallback-one", "fallback-two"],
        },
      },
    });

    if (continues) {
      await expect(run).resolves.toMatchObject({
        provider: "openrouter",
        model: "fallback-two",
      });
    } else {
      await expect(run).rejects.toThrow(/generation providers are unavailable/);
    }
    expect(next.doStreamCalls).toHaveLength(continues ? 1 : 0);
  },
);

it("tries the primary first, then high-thinking Gemini, then OpenRouter", async () => {
  const calls: string[] = [];
  const failing = (name: string) =>
    new MockLanguageModelV4({
      doStream: async () => {
        calls.push(name);
        // Request-shaped primary and Gemini errors must not stop the chain: only OpenRouter
        // errors are screened by the fallback-eligibility policy.
        throw Object.assign(new Error(`${name} failed`), { status: 400 });
      },
    });
  const gemini = failing("gemini");
  const primary = failing("primary");
  const fallback = new MockLanguageModelV4({
    doStream: async () => {
      calls.push("openrouter");
      return streamStep(0) as StepResult;
    },
  });
  mocks.gemini.mockReturnValue(gemini);
  mocks.responses.mockImplementation((model: string) =>
    model === "primary" ? primary : fallback,
  );

  const reply = await generateReply(messages, {
    ...baseOptions,
    providerConfig: {
      ...baseOptions.providerConfig,
      gemini: { apiKey: "gemini-key", model: "gemini-3.8-flash" },
    },
  });

  expect(mocks.gemini).toHaveBeenCalledWith("gemini-3.8-flash");
  expect(calls).toEqual(["primary", "gemini", "openrouter"]);
  expect(reply).toMatchObject({ provider: "openrouter", model: "fallback" });
  expect(gemini.doStreamCalls[0]?.providerOptions).toEqual({
    openai: {
      store: false,
      reasoningEffort: "high",
      forceReasoning: true,
      reasoningSummary: null,
    },
    google: { thinkingConfig: { thinkingLevel: "high" } },
  });
});

it("uses the primary without calling Gemini or OpenRouter when it answers", async () => {
  const primary = scriptedModel();
  const gemini = scriptedModel();
  const fallback = scriptedModel();
  mocks.gemini.mockReturnValue(gemini);
  mocks.responses.mockImplementation((model: string) =>
    model === "primary" ? primary : fallback,
  );

  const reply = await generateReply(messages, {
    ...baseOptions,
    providerConfig: {
      ...baseOptions.providerConfig,
      gemini: { apiKey: "gemini-key", model: "gemini-3.8-flash" },
    },
  });

  expect(reply).toMatchObject({
    provider: "primary-openai-compatible",
    model: "primary",
  });
  expect(primary.doStreamCalls).toHaveLength(1);
  expect(gemini.doStreamCalls).toHaveLength(0);
  expect(fallback.doStreamCalls).toHaveLength(0);
});

it("waits longer for Gemini to start answering than for other providers", async () => {
  vi.useFakeTimers();
  try {
    const slowStart = (name: string) =>
      new MockLanguageModelV4({
        doStream: async () => {
          await new Promise((resolve) => setTimeout(resolve, 30_000));
          return streamStep(0) as StepResult;
        },
      });
    const gemini = slowStart("gemini");
    mocks.gemini.mockReturnValue(gemini);
    const fallback = scriptedModel();
    mocks.responses.mockReturnValue(fallback);

    // No override: each provider gets its own default opening deadline.
    const run = generateReply(messages, {
      ...baseOptions,
      providerConfig: {
        ...baseOptions.providerConfig,
        primary: undefined,
        gemini: { apiKey: "gemini-key", model: "gemini-3.8-flash" },
      },
    });
    await vi.advanceTimersByTimeAsync(30_000);

    await expect(run).resolves.toMatchObject({ provider: "gemini" });
    expect(fallback.doStreamCalls).toHaveLength(0);
  } finally {
    vi.useRealTimers();
  }
});

it("still abandons a silent non-Gemini provider after the default deadline", async () => {
  vi.useFakeTimers();
  try {
    const silent = new MockLanguageModelV4({
      doStream: () => new Promise(() => {}),
    });
    const fallback = scriptedModel();
    mocks.responses.mockImplementation((model: string) =>
      model === "primary" ? silent : fallback,
    );

    const run = generateReply(messages, baseOptions);
    await vi.advanceTimersByTimeAsync(FIRST_CHUNK_TIMEOUT_MS);

    await expect(run).resolves.toMatchObject({ provider: "openrouter" });
  } finally {
    vi.useRealTimers();
  }
});

it("reports Gemini as the provider when it answers after primary failure", async () => {
  mocks.gemini.mockReturnValue(scriptedModel());
  const primary = new MockLanguageModelV4({
    doStream: async () => {
      throw new Error("Primary unavailable");
    },
  });
  const fallback = scriptedModel();
  mocks.responses.mockImplementation((model: string) =>
    model === "primary" ? primary : fallback,
  );

  const reply = await generateReply(messages, {
    ...baseOptions,
    providerConfig: {
      ...baseOptions.providerConfig,
      gemini: { apiKey: "gemini-key", model: "gemini-3.8-flash" },
    },
  });

  expect(reply).toMatchObject({ provider: "gemini", model: "gemini-3.8-flash" });
  expect(primary.doStreamCalls).toHaveLength(1);
  expect(fallback.doStreamCalls).toHaveLength(0);
});

it("checks text and image model availability concurrently", async () => {
  mocks.responses.mockReturnValue(scriptedModel());
  const started: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  const reply = generateReply(messages, {
    ...baseOptions,
    imageGeneration: { enabled: true, model: "gpt-image-2.5-sunburst" },
    dependencies: {
      discoverModel: async (config) => {
        started.push(config.model);
        await gate;
        return "available";
      },
    },
  });

  await vi.waitFor(() => expect(started).toEqual(["primary", "gpt-image-2.5-sunburst"]));
  release();
  await expect(reply).resolves.toMatchObject({
    provider: "primary-openai-compatible",
  });
});

it.each(["unavailable", "unknown"] as const)(
  "does not expose images when discovery is %s",
  async (availability) => {
    const model = scriptedModel();
    mocks.responses.mockReturnValue(model);
    await generateReply(messages, {
      ...baseOptions,
      imageGeneration: { enabled: true, model: "gpt-image-2.5-sunburst" },
      dependencies: {
        discoverModel: async (config) =>
          config.model === "gpt-image-2.5-sunburst" ? availability : "available",
      },
    });
    expect(
      model.doStreamCalls[0]?.tools?.map((tool) => tool.name),
    ).not.toContain("generate_image");
  },
);

it("skips a primary text model only when discovery definitely excludes it", async () => {
  mocks.responses.mockReturnValue(scriptedModel());
  const reply = await generateReply(messages, {
    ...baseOptions,
    dependencies: { discoverModel: async () => "unavailable" },
  });
  expect(mocks.responses.mock.calls.map((call) => call[0])).toEqual([
    "fallback",
  ]);
  expect(reply.provider).toBe("openrouter");
});

it("does not log raw SDK stream errors", async () => {
  const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
  mocks.responses.mockReturnValue(
    new MockLanguageModelV4({
      doStream: async () => ({
        stream: simulateReadableStream({
          initialDelayInMs: null,
          chunkDelayInMs: null,
          chunks: [
            {
              type: "error",
              error: new Error("private upstream body with secret prompt"),
            },
          ],
        }),
      }),
    }),
  );
  await expect(generateReply(messages, baseOptions)).rejects.toThrow(
    /private upstream/,
  );
  expect(errorLog).not.toHaveBeenCalled();
});

it("uses one explicit opening deadline for every provider when overridden", () => {
  expect(openingDeadlineMs("gemini")).toBe(GEMINI_FIRST_CHUNK_TIMEOUT_MS);
  expect(openingDeadlineMs("openrouter")).toBe(FIRST_CHUNK_TIMEOUT_MS);
  expect(openingDeadlineMs("primary-openai-compatible")).toBe(
    FIRST_CHUNK_TIMEOUT_MS,
  );
  expect(openingDeadlineMs("gemini", 20)).toBe(20);
});
