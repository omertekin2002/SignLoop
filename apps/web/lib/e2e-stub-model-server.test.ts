import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  STUB_MODEL,
  startStubModelServer,
  stubReply,
  stubTitle,
  type StubModelServer,
} from "@/e2e/stub-model-server";

// The signed-in suite's stub model (e2e/stub-model-server.ts), run against the app's real chat binding and the installed AI
// SDK, outside a browser: if the Responses events it streams stop matching what @ai-sdk/openai
// parses, this fails here rather than as a flaky browser test.

let stub: StubModelServer;

beforeEach(async () => {
  // Port 0: any free port, so this never collides with a running signed-in suite.
  stub = await startStubModelServer(0);
  vi.resetModules();
  for (const [name, value] of Object.entries({
    PRIMARY_LLM_BASE_URL: stub.url,
    PRIMARY_LLM_MODEL: STUB_MODEL,
    PRIMARY_LLM_API_KEY: "",
    OPENROUTER_API_KEY: "",
    WEB_SEARCH_PROVIDER: "",
  })) {
    vi.stubEnv(name, value);
  }
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.resetModules();
  await stub.close();
});

describe("the end-to-end stub model", () => {
  it("is discovered as the only primary model, text-only", async () => {
    const { getModelAvailabilitySnapshot } = await import("@/lib/model-settings");
    expect(await getModelAvailabilitySnapshot({ forceRefresh: true })).toEqual({
      availablePrimaryModels: [STUB_MODEL],
      availableImageInputModels: [],
      imageGenerationAvailable: false,
    });
  });

  it("streams its fixed Markdown reply through the chat engine, without calling a tool", async () => {
    const { generateChatReplyStream } = await import("@/lib/chat");
    const question = "What does clause E2E-42 say?";
    const deltas: string[] = [];
    let reply: { message: string; model: string; provider: string; toolActivity?: unknown[] } | null = null;
    for await (const chunk of generateChatReplyStream(
      [
        { role: "system", content: "You are a test assistant." },
        { role: "user", content: question },
      ],
      { primaryModel: STUB_MODEL, enableWebSearch: true, enableUrlReader: true, enableHttpFetch: true },
    )) {
      if (chunk.type === "delta") deltas.push(chunk.text);
      if (chunk.type === "done") reply = chunk.reply;
    }

    expect(reply).toMatchObject({
      message: stubReply(question),
      model: STUB_MODEL,
      provider: "primary-openai-compatible",
    });
    expect(reply!.toolActivity ?? []).toEqual([]);
    // Streamed in several deltas, not as one block.
    expect(deltas.length).toBeGreaterThan(1);
    expect(deltas.join("")).toBe(stubReply(question));

    const requests = stub.requests();
    expect(requests).toEqual([
      expect.objectContaining({ model: STUB_MODEL, kind: "reply", question }),
    ]);
    // Tools were offered, and the stub answered without using them.
    expect(requests[0]?.tools.length).toBeGreaterThan(0);
  });

  it("answers the app's title request with its fixed title", async () => {
    const { generateChatTitle } = await import("@/lib/chat-title");
    const question = "Does E2E-7 renew?";
    const title = await generateChatTitle(question, {
      primaryModel: STUB_MODEL,
      signal: new AbortController().signal,
    });

    expect(title).toBe(stubTitle(question));
    expect(stub.requests()).toEqual([
      expect.objectContaining({ kind: "title", model: STUB_MODEL }),
    ]);
  });

  it("reports what it received over HTTP, and refuses a non-streaming request", async () => {
    const refused = await fetch(`${stub.url}/responses`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: STUB_MODEL, input: "hi" }),
    });
    expect(refused.status).toBe(400);

    const streamed = await fetch(`${stub.url}/responses`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: STUB_MODEL,
        stream: true,
        input: [{ role: "user", content: [{ type: "input_text", text: "Hello stub" }] }],
      }),
    });
    expect(streamed.headers.get("content-type")).toContain("text/event-stream");
    const events = (await streamed.text())
      .split("\n\n")
      .filter(Boolean)
      .map((block) => JSON.parse(block.split("\n").find((line) => line.startsWith("data: "))!.slice(6)) as { type: string });
    expect(events.map((event) => event.type)).toEqual([
      "response.created",
      "response.output_item.added",
      ...events.slice(2, -2).map(() => "response.output_text.delta"),
      "response.output_item.done",
      "response.completed",
    ]);
    expect(events.length).toBeGreaterThan(5);

    const recorded = await fetch(`${stub.url}/__e2e/requests`);
    expect(await recorded.json()).toEqual({
      data: [{ model: STUB_MODEL, kind: "reply", question: "Hello stub", tools: [] }],
    });
  });
});
