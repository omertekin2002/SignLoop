import { beforeEach, describe, expect, it, vi } from "vitest";
import { MockLanguageModelV4 } from "ai/test";
import { simulateReadableStream } from "ai";

const mocks = vi.hoisted(() => ({
  search: vi.fn(),
  readUrl: vi.fn(),
  httpGet: vi.fn(),
}));
vi.mock("./web-search", () => ({ searchWeb: mocks.search }));
vi.mock("./url-reader", () => ({ readUrl: mocks.readUrl }));
vi.mock("./http-fetch", () => ({ httpGet: mocks.httpGet }));
import {
  generateChatReply,
  generateChatReplyStream,
  type ChatEngineOptions,
  type ChatMessage,
  type ChatReplyStreamChunk,
} from "./chat";
import type { ResearchMode } from "./research-policy";

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};
type StepResult = Awaited<ReturnType<MockLanguageModelV4["doStream"]>>;
function step(chunks: unknown[], finishReason: string): StepResult {
  return {
    stream: simulateReadableStream({
      initialDelayInMs: null,
      chunkDelayInMs: null,
      chunks: [
        ...chunks,
        { type: "finish", finishReason: { unified: finishReason, raw: undefined }, usage },
      ],
    }),
  } as StepResult;
}
const call = (id: string, toolName: string, input: unknown) =>
  step([{ type: "tool-call", toolCallId: id, toolName, input: JSON.stringify(input) }], "tool-calls");
const answer = () =>
  step(
    [
      { type: "text-start", id: "text" },
      { type: "text-delta", id: "text", delta: "Grounded answer [1]" },
      { type: "text-end", id: "text" },
    ],
    "stop",
  );
function scripted(steps: StepResult[] = []) {
  const queue = [...steps];
  return new MockLanguageModelV4({ doStream: async () => queue.shift() ?? answer() });
}
const messages: ChatMessage[] = [{ role: "user", content: "What is the rate today?" }];
function options(
  model: MockLanguageModelV4,
  researchMode?: ResearchMode,
): ChatEngineOptions {
  return {
    providers: [
      { kind: "language-model", provider: "test", model: "mock", languageModel: model },
    ],
    researchMode,
    tools: { webSearch: {}, urlReader: {}, httpFetch: {} },
  };
}
async function collect(stream: AsyncIterable<ChatReplyStreamChunk>) {
  const chunks: ChatReplyStreamChunk[] = [];
  try {
    for await (const chunk of stream) chunks.push(chunk);
    return { chunks, error: null };
  } catch (error) {
    return { chunks, error };
  }
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.search.mockImplementation(async (query: string) => ({
    provider: "brave",
    query,
    brief: null,
    results: [{ title: "Lead", url: "https://source.test/", snippet: "A lead" }],
  }));
  mocks.readUrl.mockImplementation(async (url: string) => ({
    title: "Fresh page",
    url,
    content: "Fresh source text",
    truncated: false,
    provider: "jina",
  }));
});

describe("research modes", () => {
  it("offers the configured research tools in auto mode and streams the answer", async () => {
    const model = scripted();
    const { chunks } = await collect(generateChatReplyStream(messages, options(model)));
    expect(model.doStreamCalls[0]?.tools?.map((tool) => tool.name)).toEqual([
      "search_web",
      "read_url",
      "http_get",
    ]);
    expect(model.doStreamCalls[0]?.toolChoice).toEqual({ type: "auto" });
    expect(JSON.stringify(model.doStreamCalls[0]?.prompt)).not.toContain(
      "Fresh research is required",
    );
    expect(chunks.map((chunk) => chunk.type)).toEqual(["delta", "done"]);
  });

  it("withholds the research tools in never mode", async () => {
    const model = scripted();
    await generateChatReply(messages, options(model, "never"));
    expect(model.doStreamCalls[0]?.tools ?? []).toEqual([]);
    expect(JSON.stringify(model.doStreamCalls[0]?.prompt)).toContain(
      "No tools are available",
    );
  });

  it("requires a fresh read in always mode and releases the answer only afterwards", async () => {
    const model = scripted([call("c1", "read_url", { url: "https://source.test/new" })]);
    const { chunks, error } = await collect(
      generateChatReplyStream(messages, options(model, "always")),
    );
    expect(error).toBeNull();
    expect(JSON.stringify(model.doStreamCalls[0]?.prompt)).toContain(
      "Fresh research is required",
    );
    expect(model.doStreamCalls[0]?.toolChoice).toEqual({ type: "required" });
    expect(model.doStreamCalls[1]?.toolChoice).toEqual({ type: "auto" });
    expect(chunks.map((chunk) => chunk.type)).toEqual(["tool", "tool", "delta", "done"]);
    const done = chunks.at(-1);
    if (done?.type !== "done") throw new Error("missing done");
    expect(done.reply.readSources).toEqual([1]);
    expect(done.reply.agentMessages?.some((message) => message.role === "tool")).toBe(true);
  });

  it("rejects a search-only answer in always mode without emitting answer text", async () => {
    const model = scripted([call("c1", "search_web", { query: "rate today" })]);
    const { chunks, error } = await collect(
      generateChatReplyStream(messages, options(model, "always")),
    );
    expect(error).toMatchObject({ name: "ResearchUnavailableError" });
    expect(chunks.some((chunk) => chunk.type === "tool")).toBe(true);
    expect(chunks.some((chunk) => chunk.type === "delta" || chunk.type === "done")).toBe(false);
  });

  it("does not accept an inherited catalog or an error response as fresh evidence", async () => {
    await expect(
      generateChatReply(
        [
          { role: "user", content: "Earlier question" },
          {
            role: "assistant",
            content: "Earlier answer [1]",
            webSources: [{ title: "Old", url: "https://old.test/" }],
          },
          { role: "user", content: "Check it again" },
        ],
        options(scripted(), "always"),
      ),
    ).rejects.toMatchObject({ name: "ResearchUnavailableError" });

    mocks.httpGet.mockResolvedValue({
      url: "https://api.test/rate",
      status: 404,
      contentType: "text/plain",
      body: "Not found",
      truncated: false,
    });
    await expect(
      generateChatReply(
        messages,
        options(scripted([call("c1", "http_get", { url: "https://api.test/rate" })]), "always"),
      ),
    ).rejects.toMatchObject({ name: "ResearchUnavailableError" });
  });

  it("fails before calling a provider when always mode has no tool that fetches text", async () => {
    const model = scripted();
    await expect(
      generateChatReply(messages, {
        ...options(model, "always"),
        tools: { webSearch: {} },
      }),
    ).rejects.toMatchObject({ name: "ResearchUnavailableError" });
    expect(model.doStreamCalls).toHaveLength(0);
  });
});
