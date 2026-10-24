// Real @ai-sdk/google serialization against a stubbed Gemini API.
import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ search: vi.fn() }));
vi.mock("../src/pipeline/web-search", () => ({ searchWeb: mocks.search }));
import { generateChatReply } from "../src/pipeline/chat";
import { parseClientAgentMessages } from "../src/pipeline/chat-policy";
import type { FetchImplementation } from "../src/pipeline/llm-client";

const STREAM_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:streamGenerateContent?alt=sse";

function sse(parts: unknown[]) {
  const event = {
    candidates: [
      { content: { role: "model", parts }, finishReason: "STOP", index: 0 },
    ],
    usageMetadata: {
      promptTokenCount: 10,
      candidatesTokenCount: 5,
      totalTokenCount: 15,
    },
    modelVersion: "gemini-3.8-flash",
  };
  return new Response(`data: ${JSON.stringify(event)}\r\n\r\n`, {
    headers: { "Content-Type": "text/event-stream" },
  });
}
const searchCall = () =>
  sse([
    {
      functionCall: { name: "search_web", args: { query: "current rates" } },
      thoughtSignature: "sig-1",
    },
  ]);
const answer = () => sse([{ text: "Grounded answer [1]" }]);

const options = (fetch: FetchImplementation) => ({
  providerConfig: {
    gemini: { apiKey: "gemini-key", model: "gemini-3.8-flash" },
    publicServiceUrl: "https://service.test",
    appName: "Test",
  },
  dependencies: { fetch },
});
const body = (fetchMock: ReturnType<typeof vi.fn>, call: number) =>
  JSON.parse(fetchMock.mock.calls[call]![1].body);

beforeEach(() => {
  mocks.search.mockReset().mockResolvedValue({
    provider: "brave",
    query: "current rates",
    brief: null,
    results: [
      { title: "Source", url: "https://source.test", snippet: "Verified evidence" },
    ],
  });
});

it("calls Gemini natively with its key, high thinking, and tool continuation", async () => {
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(searchCall())
    .mockResolvedValueOnce(answer());

  const reply = await generateChatReply(
    [{ role: "user", content: "Research current rates" }],
    options(fetchMock),
  );

  expect(reply).toMatchObject({
    message: "Grounded answer [1]",
    provider: "gemini",
    model: "gemini-3.8-flash",
  });
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(String(fetchMock.mock.calls[0]![0])).toBe(STREAM_URL);
  const headers = new Headers(fetchMock.mock.calls[0]![1].headers);
  expect(headers.get("x-goog-api-key")).toBe("gemini-key");
  expect(headers.get("authorization")).toBeNull();

  const first = body(fetchMock, 0);
  expect(first.generationConfig).toMatchObject({
    thinkingConfig: { thinkingLevel: "high" },
  });
  // No service cap: Gemini's own output limit applies, leaving room for high thinking.
  expect(first.generationConfig).not.toHaveProperty("maxOutputTokens");
  expect(first.tools[0].functionDeclarations).toEqual(
    expect.arrayContaining([expect.objectContaining({ name: "search_web" })]),
  );

  // The continuation must carry the signed call and its result, or Gemini 3 rejects it.
  const second = JSON.stringify(body(fetchMock, 1).contents);
  expect(second).toContain('"thoughtSignature":"sig-1"');
  expect(second).toContain('"functionResponse"');
  expect(second).toContain("Verified evidence");
});

it("keeps Gemini's thought signature through client replay on the next turn", async () => {
  const firstFetch = vi
    .fn()
    .mockResolvedValueOnce(searchCall())
    .mockResolvedValueOnce(answer());
  const first = await generateChatReply(
    [{ role: "user", content: "Research current rates" }],
    options(firstFetch),
  );

  // Exactly what the HTTP boundary does with agentMessages a client sends back.
  const replay = parseClientAgentMessages(
    JSON.parse(JSON.stringify(first.agentMessages)),
  );
  expect(replay).toBeDefined();

  const nextFetch = vi.fn().mockResolvedValueOnce(answer());
  await generateChatReply(
    [
      { role: "user", content: "Research current rates" },
      { role: "assistant", content: first.message, agentMessages: replay },
      { role: "user", content: "Explain that source" },
    ],
    options(nextFetch),
  );

  const contents = JSON.stringify(body(nextFetch, 0).contents);
  expect(contents).toContain('"thoughtSignature":"sig-1"');
  expect(contents).not.toContain("skip_thought_signature_validator");
});

it("replays tool calls answered by another provider without failing Gemini 3 validation", async () => {
  const nextFetch = vi.fn().mockResolvedValueOnce(answer());

  await generateChatReply(
    [
      { role: "user", content: "Research current rates" },
      {
        role: "assistant",
        content: "Answer [1]",
        // An OpenRouter-served turn: tool calls carry no Gemini signature.
        agentMessages: [
          {
            role: "assistant",
            content: [
              {
                type: "tool-call",
                toolCallId: "c1",
                toolName: "search_web",
                input: { query: "current rates" },
              },
            ],
          },
          {
            role: "tool",
            content: [
              {
                type: "tool-result",
                toolCallId: "c1",
                toolName: "search_web",
                output: { type: "json", value: { results: [] } },
              },
            ],
          },
          { role: "assistant", content: "Answer [1]" },
        ],
      },
      { role: "user", content: "Explain that source" },
    ],
    options(nextFetch),
  );

  expect(JSON.stringify(body(nextFetch, 0).contents)).toContain(
    "skip_thought_signature_validator",
  );
});
