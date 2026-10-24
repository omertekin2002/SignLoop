// Ported from SignLoop at 61c90b508a789cee988acdded52b2d1a8c82ee69.
import { afterEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ search: vi.fn() }));
vi.mock("../src/pipeline/web-search", () => ({ searchWeb: mocks.search }));
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
});
function response(events: unknown[]) {
  return new Response(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
    { headers: { "Content-Type": "text/event-stream" } },
  );
}
const created = {
  type: "response.created",
  response: { id: "resp_test", model: "test", created_at: 1 },
};
const completed = {
  type: "response.completed",
  response: { status: "completed" },
};
const textEvents = [
  created,
  {
    type: "response.output_item.added",
    output_index: 0,
    item: { type: "message", id: "msg" },
  },
  {
    type: "response.output_text.delta",
    item_id: "msg",
    output_index: 0,
    content_index: 0,
    delta: "Grounded answer [1]",
  },
  {
    type: "response.output_item.done",
    output_index: 0,
    item: { type: "message", id: "msg" },
  },
  completed,
];
it("uses real Responses serialization for tools and continuation", async () => {
  vi.resetModules();
  mocks.search.mockResolvedValue({
    provider: "brave",
    query: "current rates",
    brief: null,
    results: [
      {
        title: "Source",
        url: "https://source.test",
        snippet: "Verified evidence",
      },
    ],
  });
  const fn = {
    type: "function_call",
    id: "fc1",
    call_id: "call1",
    name: "search_web",
    arguments: '{"query":"current rates"}',
  };
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(
      response([
        created,
        {
          type: "response.output_item.added",
          output_index: 0,
          item: { ...fn, arguments: "" },
        },
        {
          type: "response.function_call_arguments.delta",
          item_id: "fc1",
          output_index: 0,
          delta: fn.arguments,
        },
        {
          type: "response.output_item.done",
          output_index: 0,
          item: { ...fn, status: "completed" },
        },
        completed,
      ]),
    )
    .mockResolvedValueOnce(response(textEvents));
  vi.stubGlobal("fetch", fetchMock);
  const { generateChatReply } = await import("../src/pipeline/chat");
  const reply = await generateChatReply(
    [{ role: "user", content: "Research current rates" }],
    options,
  );
  expect(reply.message).toBe("Grounded answer [1]");
  expect(fetchMock).toHaveBeenCalledTimes(2);
  const first = JSON.parse(fetchMock.mock.calls[0]![1].body);
  const second = JSON.parse(fetchMock.mock.calls[1]![1].body);
  expect(first.tool_choice).toBe("auto");
  expect(first.tools).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ type: "function", name: "search_web" }),
    ]),
  );
  expect(first.store).toBe(false);
  for (const request of [first, second]) {
    expect(request.reasoning).toEqual({ effort: "high" });
  }
  expect(second.input).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        type: "function_call_output",
        call_id: "call1",
        output: expect.stringContaining("Verified evidence"),
      }),
    ]),
  );
});

it.each([
  "gpt-6.1-sol",
  "gemini-3.8-flash",
  "claude-fable-5.1",
  "custom-text-model",
])("sends high reasoning effort for the primary gateway alias %s", async (model) => {
  const fetchMock = vi.fn().mockResolvedValue(response(textEvents));
  vi.stubGlobal("fetch", fetchMock);
  const { generateChatReply } = await import("../src/pipeline/chat");

  const reply = await generateChatReply([{ role: "user", content: "Hello" }], {
    ...options,
    providerConfig: {
      ...options.providerConfig,
      primary: { ...options.providerConfig.primary, model },
    },
    researchMode: "never",
  });

  expect(reply).toMatchObject({ provider: "primary-openai-compatible", model });
  expect(fetchMock).toHaveBeenCalledOnce();
  const request = JSON.parse(fetchMock.mock.calls[0]![1].body);
  expect(request.model).toBe(model);
  expect(request.reasoning).toEqual({ effort: "high" });
  expect(request.store).toBe(false);
});

it("preserves high reasoning when falling back from primary to openrouter/free", async () => {
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(
      Response.json({ error: { message: "Primary unavailable" } }, { status: 503 }),
    )
    .mockResolvedValueOnce(response(textEvents));
  vi.stubGlobal("fetch", fetchMock);
  const { generateChatReply } = await import("../src/pipeline/chat");

  const reply = await generateChatReply([{ role: "user", content: "Hello" }], {
    ...options,
    providerConfig: {
      ...options.providerConfig,
      openRouter: {
        baseURL: "https://openrouter.test/v1",
        apiKey: "fallback-key",
        models: ["openrouter/free"],
      },
    },
    researchMode: "never",
  });

  expect(reply).toMatchObject({ provider: "openrouter", model: "openrouter/free" });
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
    "https://primary.test/v1/responses",
    "https://openrouter.test/v1/responses",
  ]);
  for (const [, init] of fetchMock.mock.calls) {
    const request = JSON.parse(init.body);
    expect(request.reasoning).toEqual({ effort: "high" });
    expect(request.store).toBe(false);
  }
  expect(JSON.parse(fetchMock.mock.calls[1]![1].body).model).toBe("openrouter/free");
});

it("rejects Responses EOF before the provider completion event", async () => {
  vi.resetModules();
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(response(textEvents.slice(0, -1))),
  );
  const { generateChatReply } = await import("../src/pipeline/chat");
  await expect(
    generateChatReply([{ role: "user", content: "hello" }], options),
  ).rejects.toThrow(/did not complete|before successful completion/);
});

const options = {
  providerConfig: {
    primary: {
      baseURL: "https://primary.test/v1",
      apiKey: "test",
      model: "test",
    },
    publicServiceUrl: "https://service.test",
    appName: "Test",
  },
  dependencies: { discoverModel: async () => "available" as const },
};
