import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MockLanguageModelV4 } from "ai/test";
import { simulateReadableStream } from "ai";

const mocks = vi.hoisted(() => ({ search: vi.fn(), responses: vi.fn() }));
vi.mock("@ai-sdk/openai", () => ({
  createOpenAI: () => ({ responses: mocks.responses }),
}));
vi.mock("@/lib/gemini-search", () => ({ searchWeb: mocks.search }));
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
    const model = scriptedModel(["A", "a", "B", "C", "D"]);
    mocks.responses.mockReturnValue(model);
    await generateChatReply(messages, { enableWebSearch: true });
    expect(mocks.search.mock.calls.map((call) => call[0])).toEqual([
      "A",
      "B",
      "C",
    ]);
    expect(model.doStreamCalls).toHaveLength(6);
    expect(model.doStreamCalls[5]?.toolChoice).toEqual({ type: "none" });
    expect(JSON.stringify(model.doStreamCalls[5]?.prompt)).toContain(
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
});
