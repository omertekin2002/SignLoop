import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MockLanguageModelV4 } from "ai/test";
import { simulateReadableStream } from "ai";
import { compactAgentMessages } from "./chat-agent-history";

const mocks = vi.hoisted(() => ({
  search: vi.fn(),
  responses: vi.fn(),
  readUrl: vi.fn(),
  generateImage: vi.fn(),
}));
vi.mock("@ai-sdk/openai", () => ({
  createOpenAI: () => ({ responses: mocks.responses }),
}));
vi.mock("./web-search", () => ({ searchWeb: mocks.search }));
vi.mock("./url-reader", () => ({ readUrl: mocks.readUrl }));
vi.mock("./image-generation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./image-generation")>()),
  generateImageReply: mocks.generateImage,
}));
import * as engine from "./chat";
import type { ChatMessage, ChatReplyStreamChunk } from "./chat";
import { createRoutedModel, type ChatProviderCandidate } from "./routing";

/** A primary endpoint followed by one fallback, both served by the mocked createOpenAI. */
function providers(): ChatProviderCandidate[] {
  return [
    {
      kind: "openai-responses",
      provider: "primary-openai-compatible",
      model: "primary",
      baseURL: "https://primary.test/v1",
      apiKey: "test",
    },
    {
      kind: "openai-responses",
      provider: "openrouter",
      model: "fallback",
      baseURL: "https://fallback.test/v1",
      apiKey: "test",
    },
  ];
}
const imageGeneration = {
  baseURL: "https://primary.test/v1",
  model: "image-model",
};
type TestOptions = {
  enableWebSearch?: boolean;
  enableUrlReader?: boolean;
  enableImageGeneration?: boolean;
  userId?: string;
  firstChunkTimeoutMs?: number;
  onTiming?: engine.ChatEngineOptions["onTiming"];
};
// The scenarios below use SignLoop's per-turn switches; map them to engine configuration.
function options(input: TestOptions = {}): engine.ChatEngineOptions {
  return {
    providers: providers(),
    firstChunkTimeoutMs: input.firstChunkTimeoutMs,
    onTiming: input.onTiming,
    tools: {
      ...(input.enableWebSearch ? { webSearch: {} } : {}),
      ...(input.enableUrlReader ? { urlReader: {} } : {}),
      ...(input.enableImageGeneration
        ? { imageGeneration: { ...imageGeneration, userId: input.userId } }
        : {}),
    },
  };
}
const generateChatReply = (
  messages: readonly ChatMessage[],
  input?: TestOptions,
) => engine.generateChatReply(messages, options(input));
const generateChatReplyStream = (
  messages: readonly ChatMessage[],
  input?: TestOptions,
) => engine.generateChatReplyStream(messages, options(input));

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
/** One step that uses the endpoint's hosted image tool, as @ai-sdk/openai streams it. */
function hostedImageStep(
  outputs: unknown[],
  text = "",
  then?: { toolName: string; input: Record<string, unknown> },
) {
  return {
    stream: simulateReadableStream({
      initialDelayInMs: null,
      chunkDelayInMs: null,
      chunks: [
        ...outputs.flatMap((output, index) => [
          {
            type: "tool-call",
            toolCallId: `ig-${index}`,
            toolName: "image_generation",
            input: "{}",
            providerExecuted: true,
          },
          {
            type: "tool-result",
            toolCallId: `ig-${index}`,
            toolName: "image_generation",
            result: output,
          },
        ]),
        { type: "text-start", id: "text" },
        ...(text ? [{ type: "text-delta", id: "text", delta: text }] : []),
        { type: "text-end", id: "text" },
        ...(then
          ? [
              {
                type: "tool-call",
                toolCallId: "call-then",
                toolName: then.toolName,
                input: JSON.stringify(then.input),
              },
            ]
          : []),
        {
          type: "finish",
          finishReason: {
            unified: then ? "tool-calls" : "stop",
            raw: "completed",
          },
          usage,
        },
      ],
    }),
  };
}
type StepResult = Awaited<ReturnType<MockLanguageModelV4["doStream"]>>;
function sequencedModel(steps: Array<{ stream: ReadableStream<unknown> }>) {
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
        agentMessages: [{
          role: "assistant",
          content: [{ type: "text", text: `${answer.slice(0, 2000)}\n[Replay excerpt]` }],
        }],
      },
      { role: "user", content: "What was that deadline?" },
    ]);

    const assistant = model.doStreamCalls[0]?.prompt.find((message) => message.role === "assistant");
    expect(assistant?.content).toEqual([{ type: "text", text: answer, providerOptions: undefined }]);
  });

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

  it.each([false, true])("keeps the full canonical answer after tool replay (legacy=%s)", async (legacy) => {
    const answer = `${"x".repeat(2500)} The renewal deadline is September 30.`;
    const transcript = [
      { role: "assistant", content: [
        { type: "text", text: "Old clipped commentary" },
        { type: "tool-call", toolCallId: "c1", toolName: "read_url", input: { url: "https://law.test" } },
      ] },
      { role: "tool", content: [{ type: "tool-result", toolCallId: "c1", toolName: "read_url", output: { type: "text", value: "Source evidence" } }] },
      { role: "assistant", content: answer.slice(0, 2000) },
    ] as const;
    const replay = compactAgentMessages(transcript);
    const model = scriptedModel();
    mocks.responses.mockReturnValue(model);
    await generateChatReply([
      { role: "user", content: "Explain the renewal." },
      { role: "assistant", content: answer, agentMessages: legacy ? JSON.parse(JSON.stringify(transcript)) : replay },
      { role: "user", content: "What was that deadline?" },
    ]);
    const prompt = JSON.stringify(model.doStreamCalls[0]?.prompt);
    expect(prompt.match(/September 30/g)).toHaveLength(1);
    expect(prompt).toContain("Source evidence");
    expect(prompt).not.toContain("Old clipped commentary");
    expect(model.doStreamCalls[0]?.prompt.filter((message) => message.role === "tool")).toHaveLength(1);
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
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    const reply = await generateChatReply(messages, { enableWebSearch: true });
    expect(reply.provider).toBe("openrouter");
    expect(warned).toHaveBeenCalledExactlyOnceWith("Chat provider step failed", {
      provider: "primary-openai-compatible",
      model: "primary",
      errorClass: "Error",
    });
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
    ).rejects.toThrow(/no response within 20ms/);
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
    const routed = createRoutedModel(providers());
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

  it("reads new evidence after a full inherited catalog and continues with stable citations", async () => {
    mocks.readUrl.mockResolvedValue({ title: "New source", url: "https://new.test", content: "Fresh evidence", truncated: false, provider: "jina" });
    const model = sequencedModel([toolStep(0, "read_url", { url: "https://new.test" })]);
    mocks.responses.mockReturnValue(model);
    const sources = Array.from({ length: 64 }, (_, index) => ({ title: `Old ${index}`, url: `https://old.test/${index}` }));
    const reply = await generateChatReply([
      { role: "assistant", content: "Old answer [64]", webSources: sources },
      { role: "user", content: "Read this new source" },
    ], { enableUrlReader: true });
    expect(reply.toolActivity?.[0]?.status).toBe("complete");
    expect(reply.readSources).toEqual([65]);
    expect(reply.webSearch?.sources.at(-1)).toEqual({ number: 65, title: "New source", url: "https://new.test" });
    expect(JSON.stringify(model.doStreamCalls[1]?.prompt)).toContain("Fresh evidence");
    expect(reply.webSearch?.sources).toHaveLength(64);
  });

  it("refuses searches and reads before paying for them once no source can be numbered", async () => {
    const model = sequencedModel([
      toolStep(0, "search_web", { query: "anything" }),
      toolStep(1, "read_url", { url: "https://new.test" }),
    ]);
    mocks.responses.mockReturnValue(model);
    const sources = [{ number: Number.MAX_SAFE_INTEGER, title: "Last", url: "https://last.test" }];
    const reply = await generateChatReply([
      { role: "assistant", content: "Old answer", webSources: sources },
      { role: "user", content: "Look this up" },
    ], { enableWebSearch: true, enableUrlReader: true });
    expect(mocks.search).not.toHaveBeenCalled();
    expect(mocks.readUrl).not.toHaveBeenCalled();
    expect(reply.toolActivity?.map((activity) => activity.status)).toEqual(["error", "error"]);
    expect(JSON.stringify(model.doStreamCalls[2]?.prompt)).toContain("limit of numbered sources");
    expect(reply.webSearch?.sources).toEqual(sources);
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
      userId: "user-1",
    }))
      chunks.push(chunk);
    expect(mocks.generateImage).toHaveBeenCalledWith(
      "a signed contract on a desk",
      expect.objectContaining({ userId: "user-1" }),
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
    ).toEqual(["search_web"]);
  });

  it("keeps an image made by the endpoint's hosted image tool", async () => {
    const png = "iVBORw0KGgoAAAANSUhEUg==";
    const model = sequencedModel([hostedImageStep([{ result: png }])]);
    mocks.responses.mockReturnValue(model);
    const chunks: ChatReplyStreamChunk[] = [];
    for await (const chunk of generateChatReplyStream(messages, {
      enableImageGeneration: true,
    }))
      chunks.push(chunk);
    const markdown = `![Generated image](data:image/png;base64,${png})`;
    expect(
      chunks.filter((chunk) => chunk.type === "delta").map((chunk) => chunk.text),
    ).toEqual([markdown]);
    const done = chunks.at(-1);
    if (done?.type !== "done") throw new Error("missing done");
    expect(done.reply.message).toBe(markdown);
    expect(done.reply.toolActivity).toEqual([
      { id: "ig-0", tool: "generate_image", query: "", status: "complete" },
    ]);
    // The provider-executed exchange has no tool message to pair with, so it is never replayed.
    expect(done.reply.agentMessages).toBeUndefined();
    expect(mocks.generateImage).not.toHaveBeenCalled();
  });

  it("drops hosted images that are disabled, not PNG, or over budget", async () => {
    const png = "iVBORw0KGgoAAAANSUhEUg==";
    mocks.responses.mockReturnValue(
      sequencedModel([hostedImageStep([{ result: png }])]),
    );
    await expect(generateChatReply(messages)).rejects.toThrow(
      "AI stream ended before successful completion",
    );

    mocks.responses.mockReturnValue(
      sequencedModel([
        hostedImageStep(
          [
            { result: "/9j/4AAQSkZJRgABAQ==" },
            { result: png },
            { result: png },
            { result: png },
          ],
          "Here it is.",
        ),
      ]),
    );
    const reply = await generateChatReply(messages, {
      enableImageGeneration: true,
    });
    const markdown = `![Generated image](data:image/png;base64,${png})`;
    expect(reply.message).toBe(`${markdown}\n\n${markdown}\n\nHere it is.`);
    expect(reply.toolActivity?.map(({ id, status }) => [id, status])).toEqual([
      ["ig-0", "error"],
      ["ig-1", "complete"],
      ["ig-2", "complete"],
      ["ig-3", "error"],
    ]);
  });

  it("shares one image budget between generate_image and hosted image calls", async () => {
    const png = "iVBORw0KGgoAAAANSUhEUg==";
    const hosted = `![Generated image](data:image/png;base64,${png})`;
    const local = "![Generated image](data:image/png;base64,AAAA)";
    mocks.generateImage.mockResolvedValue({
      message: local,
      model: "gpt-image-2.5-sunburst",
      provider: "primary-openai-compatible",
    });
    mocks.responses.mockReturnValue(
      sequencedModel([
        toolStep(0, "generate_image", { prompt: "a contract" }),
        hostedImageStep([{ result: png }, { result: png }], "Done."),
      ]),
    );
    const localFirst = await generateChatReply(messages, {
      enableImageGeneration: true,
    });
    expect(localFirst.message).toBe(`${local}\n\n${hosted}\n\nDone.`);
    expect(
      localFirst.toolActivity?.map(({ id, status }) => [id, status]),
    ).toEqual([
      ["call-0", "complete"],
      ["ig-0", "complete"],
      ["ig-1", "error"],
    ]);

    mocks.generateImage.mockClear();
    const hostedFirst = sequencedModel([
      hostedImageStep([{ result: png }, { result: png }], "", {
        toolName: "generate_image",
        input: { prompt: "one more" },
      }),
    ]);
    mocks.responses.mockReturnValue(hostedFirst);
    const reply = await generateChatReply(messages, {
      enableImageGeneration: true,
    });
    expect(mocks.generateImage).not.toHaveBeenCalled();
    expect(reply.message).toBe(`${hosted}\n\n${hosted}\n\nAnswer [1]`);
    expect(reply.toolActivity?.at(-1)).toMatchObject({
      id: "call-then",
      status: "error",
    });
    expect(JSON.stringify(hostedFirst.doStreamCalls[1]?.prompt)).toContain(
      "Image budget for this reply is exhausted",
    );
  });

  it("returns image failures to the model as tool errors", async () => {
    mocks.generateImage.mockRejectedValue(
      Object.assign(new Error("upstream 500 with secret details"), {
        status: 500,
      }),
    );
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
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
    expect(logged).toHaveBeenCalledWith("Image generation tool failed", {
      provider: "primary-openai-compatible",
      model: "image-model",
      errorClass: "Error",
      statusCode: 500,
    });
    expect(JSON.stringify(logged.mock.calls)).not.toContain("secret details");
  });

});

describe("provider startup timing hooks", () => {
  it("excludes opening metadata and emits first-useful only once while preserving content", async () => {
    let now = 10;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const events: { event: string; at: number }[] = [];
    let source!: ReadableStreamDefaultController;
    const model = new MockLanguageModelV4({
      doStream: async () => ({
        stream: new ReadableStream({
          start(controller) {
            source = controller;
          },
        }),
      }),
    });
    mocks.responses.mockReturnValue(model);
    const routed = createRoutedModel(providers(), {
      onTiming: (event) => events.push({ event, at: performance.now() }),
    });
    const opening = routed.model.doStream({ prompt: [] });
    expect(events).toEqual([{ event: "provider_start", at: 10 }]);
    now = 20;
    source.enqueue({ type: "stream-start", warnings: [] });
    source.enqueue({ type: "response-metadata", id: "synthetic" });
    source.enqueue({ type: "text-start", id: "text" });
    await Promise.resolve();
    await Promise.resolve();
    expect(events).toHaveLength(1);
    now = 40;
    source.enqueue({
      type: "text-delta",
      id: "text",
      delta: "Synthetic answer",
    });
    const { stream } = await opening;
    source.enqueue({ type: "text-delta", id: "text", delta: " continued" });
    source.close();
    const parts = [];
    const reader = stream.getReader();
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      parts.push(part.value);
    }
    expect(events).toEqual([
      { event: "provider_start", at: 10 },
      { event: "provider_first_useful", at: 40 },
    ]);
    expect(
      parts
        .filter((part) => part.type === "text-delta")
        .map((part) => part.delta)
        .join(""),
    ).toBe("Synthetic answer continued");
  });

  it("keeps firsts across fallback and multiple tool steps", async () => {
    const primary = new MockLanguageModelV4({
      doStream: async () => {
        throw new Error("synthetic failure");
      },
    });
    const fallback = scriptedModel(["query"]);
    mocks.responses.mockImplementation((name: string) =>
      name === "primary" ? primary : fallback,
    );
    const onTiming = vi.fn();
    const reply = await generateChatReply(messages, {
      enableWebSearch: true,
      onTiming,
    });
    expect(reply.provider).toBe("openrouter");
    expect(fallback.doStreamCalls).toHaveLength(2);
    expect(onTiming.mock.calls).toEqual([
      ["provider_start"],
      ["provider_first_useful"],
    ]);
  });

  it("does not label an error-only stream as useful output", async () => {
    const model = new MockLanguageModelV4({
      doStream: async () => ({
        stream: simulateReadableStream({
          initialDelayInMs: null,
          chunkDelayInMs: null,
          chunks: [{ type: "error", error: new Error("synthetic failure") }],
        }),
      }),
    });
    mocks.responses.mockReturnValue(model);
    const onTiming = vi.fn();
    await expect(generateChatReply(messages, { onTiming })).rejects.toThrow(
      "synthetic failure",
    );
    expect(onTiming.mock.calls).toEqual([["provider_start"]]);
  });
});

describe("caller-controlled error reporting", () => {
  function errorStreamModel(error: Error) {
    return new MockLanguageModelV4({
      doStream: async () => ({
        stream: simulateReadableStream({
          initialDelayInMs: null,
          chunkDelayInMs: null,
          chunks: [{ type: "error", error }],
        }),
      }),
    });
  }
  /** Opens with content, then waits until the run is aborted. */
  function stalledModel() {
    return new MockLanguageModelV4({
      doStream: async ({ abortSignal }) => ({
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: "text-start", id: "text" });
            controller.enqueue({
              type: "text-delta",
              id: "text",
              delta: "Partial",
            });
            abortSignal?.addEventListener("abort", () =>
              controller.error(abortSignal.reason),
            );
          },
        }),
      }),
    });
  }
  const deadline = () =>
    new DOMException("Service request timed out", "TimeoutError");

  it("keeps the AI SDK's default stream-error logging unless asked", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.responses.mockReturnValue(
      errorStreamModel(new Error("raw upstream detail")),
    );
    await expect(generateChatReply(messages)).rejects.toThrow(
      "raw upstream detail",
    );
    expect(errorLog).toHaveBeenCalled();
  });

  it("routes stream errors to onStreamError instead of the console", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const failure = new Error("raw upstream detail");
    mocks.responses.mockReturnValue(errorStreamModel(failure));
    const onStreamError = vi.fn();
    await expect(
      engine.generateChatReply(messages, { ...options(), onStreamError }),
    ).rejects.toThrow("raw upstream detail");
    expect(onStreamError).toHaveBeenCalledWith(failure);
    expect(errorLog).not.toHaveBeenCalled();
  });

  it("reports an abort generically by default", async () => {
    mocks.responses.mockReturnValue(stalledModel());
    const controller = new AbortController();
    const reply = engine.generateChatReply(messages, {
      ...options(),
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(deadline()), 10);
    await expect(reply).rejects.toThrow("Chat generation aborted");
  });

  it("rethrows the abort reason when asked", async () => {
    mocks.responses.mockReturnValue(stalledModel());
    const controller = new AbortController();
    const reason = deadline();
    const reply = engine.generateChatReply(messages, {
      ...options(),
      signal: controller.signal,
      rethrowAbortReason: true,
    });
    setTimeout(() => controller.abort(reason), 10);
    await expect(reply).rejects.toBe(reason);
  });
});
