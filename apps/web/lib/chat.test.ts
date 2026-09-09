import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MockLanguageModelV4 } from "ai/test";
import { simulateReadableStream } from "ai";

const mocks = vi.hoisted(() => ({
  search: vi.fn(),
  responses: vi.fn(),
  readUrl: vi.fn(),
  listContracts: vi.fn(),
  getContractText: vi.fn(),
  generateImage: vi.fn(),
}));
vi.mock("@ai-sdk/openai", () => ({
  createOpenAI: () => ({ responses: mocks.responses }),
}));
vi.mock("@/lib/gemini-search", () => ({ searchWeb: mocks.search }));
vi.mock("@/lib/url-reader", () => ({ readUrl: mocks.readUrl }));
vi.mock("@/lib/image-generation", () => ({ generateImageReply: mocks.generateImage }));
vi.mock("@/lib/server-db", () => ({
  listContractsForChat: mocks.listContracts,
  getContractTextForUser: mocks.getContractText,
}));
vi.mock("@/lib/llm-client", () => ({
  APP_NAME: "SignLoop",
  SITE_URL: "https://signloop.test",
  PRIMARY_LLM_BASE_URL: "https://primary.test/v1",
  PRIMARY_LLM_API_KEY: "test",
  OPENROUTER_BASE_URL: "https://fallback.test/v1",
  OPENROUTER_API_KEY: "test",
  OPENROUTER_MODELS: ["fallback"],
  resolvePrimaryModel: (value: string | null | undefined) =>
    value === null ? null : (value ?? "primary"),
}));
import {
  createRoutedModel,
  generateChatReply,
  generateChatReplyStream,
  type ChatReplyStreamChunk,
} from "./chat";

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
    brief: `Evidence for ${query}`,
    metadata: {
      query,
      attemptedQueries: [query],
      successfulSearches: 1,
      sources: [
        {
          title: "Source",
          url: "https://source.test",
          snippet: "Supported fact",
        },
      ],
    },
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
      expect(done.reply.webSearch?.sources).toHaveLength(1);
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
    const model = scriptedModel(["A", "a", "B", "C", "D", "E", "F"]);
    mocks.responses.mockReturnValue(model);
    await generateChatReply(messages, { enableWebSearch: true });
    expect(mocks.search.mock.calls.map((call) => call[0])).toEqual([
      "A",
      "B",
      "C",
    ]);
    // Eight steps: seven tool rounds, then the final step is forced to answer without tools.
    expect(model.doStreamCalls).toHaveLength(8);
    expect(model.doStreamCalls[7]?.toolChoice).toEqual({ type: "none" });
    expect(JSON.stringify(model.doStreamCalls[7]?.prompt)).toContain(
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
    expect(nextReply.webSearch?.sources).toEqual(first.webSearch?.sources);
    expect(nextReply.webSearch?.successfulSearches).toBe(0);
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
    const reply = await generateChatReply(messages, { firstChunkTimeoutMs: 20 });
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
    const reply = await generateChatReply(messages, { firstChunkTimeoutMs: 20 });
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
    const routed = createRoutedModel("primary");
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
      { title: "Statute", url: "https://law.test/statute" },
    ]);
    const continuation = JSON.stringify(model.doStreamCalls[1]?.prompt);
    expect(continuation).toContain("UNTRUSTED CONTENT");
    expect(continuation).toContain("Text of the statute");
    expect(reply.toolActivity).toEqual([
      { id: "call-0", tool: "read_url", query: "https://law.test/statute", status: "complete" },
    ]);
    expect(JSON.stringify(model.doStreamCalls[0]?.prompt)).toContain("read_url");
  });

  it("reads the user's contracts only when a user is attached", async () => {
    const contractId = "11111111-1111-4111-8111-111111111111";
    mocks.listContracts.mockResolvedValue([
      { id: contractId, title: "NDA", status: "DRAFT", projectId: null, updatedAt: "2026-01-01", characterCount: 44, extractionWarning: null },
    ]);
    mocks.getContractText.mockResolvedValue({
      id: contractId,
      title: "NDA",
      status: "DRAFT",
      text: "Clause 1. Confidentiality lasts five years.",
      extractionWarning: null,
    });
    const model = sequencedModel([
      toolStep(0, "list_contracts", {}),
      toolStep(1, "read_contract", { contractId, find: "confidentiality" }),
    ]);
    mocks.responses.mockReturnValue(model);
    const reply = await generateChatReply(messages, { contractsUserId: "user-1" });
    expect(mocks.listContracts).toHaveBeenCalledWith("user-1");
    expect(mocks.getContractText).toHaveBeenCalledWith("user-1", contractId);
    expect(JSON.stringify(model.doStreamCalls[1]?.prompt)).toContain("NDA");
    expect(JSON.stringify(model.doStreamCalls[2]?.prompt)).toContain("Confidentiality lasts");
    expect(reply.toolActivity?.map((activity) => [activity.tool, activity.status])).toEqual([
      ["list_contracts", "complete"],
      ["read_contract", "complete"],
    ]);
    expect(reply.webSearch).toBeNull();

    const anonymous = scriptedModel();
    mocks.responses.mockReturnValue(anonymous);
    await generateChatReply(messages, {});
    expect(anonymous.doStreamCalls[0]?.tools ?? []).toHaveLength(0);
    expect(JSON.stringify(anonymous.doStreamCalls[0]?.prompt)).toContain("No tools are available");
  });

  it("reports contract lookups that fail as tool errors", async () => {
    mocks.getContractText.mockResolvedValue(null);
    const model = sequencedModel([
      toolStep(0, "read_contract", { contractId: "11111111-1111-4111-8111-111111111111" }),
    ]);
    mocks.responses.mockReturnValue(model);
    const reply = await generateChatReply(messages, { contractsUserId: "user-1" });
    expect(reply.toolActivity?.[0]?.status).toBe("error");
    expect(JSON.stringify(model.doStreamCalls[1]?.prompt)).toContain("Contract not found");
  });

  it("streams a generated image into the reply without putting bytes in the transcript", async () => {
    const markdown = "![Generated image](data:image/png;base64,AAAA)";
    mocks.generateImage.mockResolvedValue({ message: markdown, model: "gpt-image-2", provider: "primary-openai-compatible" });
    const model = sequencedModel([toolStep(0, "generate_image", { prompt: "a signed contract on a desk" })]);
    mocks.responses.mockReturnValue(model);
    const chunks: ChatReplyStreamChunk[] = [];
    for await (const chunk of generateChatReplyStream(messages, { enableImageGeneration: true, userId: "user-1" })) chunks.push(chunk);
    expect(mocks.generateImage).toHaveBeenCalledWith("a signed contract on a desk", expect.objectContaining({ userId: "user-1" }));
    const deltas = chunks.filter((chunk) => chunk.type === "delta").map((chunk) => chunk.text);
    expect(deltas[0]).toBe(markdown);
    const done = chunks.at(-1);
    if (done?.type !== "done") throw new Error("missing done");
    expect(done.reply.message).toBe(`${markdown}\n\nAnswer [1]`);
    expect(JSON.stringify(done.reply.agentMessages)).not.toContain("base64");
    expect(JSON.stringify(model.doStreamCalls[1]?.prompt)).toContain('"attached"');
    expect(done.reply.toolActivity).toEqual([
      { id: "call-0", tool: "generate_image", query: "a signed contract on a desk", status: "complete" },
    ]);

    const withoutImages = scriptedModel();
    mocks.responses.mockReturnValue(withoutImages);
    await generateChatReply(messages, { enableWebSearch: true });
    expect(withoutImages.doStreamCalls[0]?.tools?.map((item) => item.name)).toEqual(["search_web"]);
  });

  it("returns image failures to the model as tool errors", async () => {
    mocks.generateImage.mockRejectedValue(new Error("upstream 500 with secret details"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const model = sequencedModel([toolStep(0, "generate_image", { prompt: "anything" })]);
    mocks.responses.mockReturnValue(model);
    const reply = await generateChatReply(messages, { enableImageGeneration: true });
    expect(reply.message).toBe("Answer [1]");
    expect(reply.toolActivity?.[0]?.status).toBe("error");
    const continuation = JSON.stringify(model.doStreamCalls[1]?.prompt);
    expect(continuation).toContain("Image generation failed");
    expect(continuation).not.toContain("secret details");
  });
});
