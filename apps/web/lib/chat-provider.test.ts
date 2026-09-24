import { afterEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ search: vi.fn() }));
vi.mock("@/lib/web-search", () => ({ searchWeb: mocks.search }));
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
  vi.stubEnv("PRIMARY_LLM_BASE_URL", "https://primary.test/v1");
  vi.stubEnv("PRIMARY_LLM_API_KEY", "test");
  vi.stubEnv("OPENROUTER_API_KEY", "");
  mocks.search.mockResolvedValue({
    provider: "brave",
    query: "current rates",
    brief: null,
    results: [
      { title: "Source", url: "https://source.test", snippet: "Verified evidence" },
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
  const { generateChatReply } = await import("./chat");
  const reply = await generateChatReply(
    [{ role: "user", content: "Research current rates" }],
    { primaryModel: "test", enableWebSearch: true },
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
it("rejects Responses EOF before the provider completion event", async () => {
  vi.resetModules();
  vi.stubEnv("PRIMARY_LLM_BASE_URL", "https://primary.test/v1");
  vi.stubEnv("OPENROUTER_API_KEY", "");
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(response(textEvents.slice(0, -1))),
  );
  const { generateChatReply } = await import("./chat");
  await expect(
    generateChatReply([{ role: "user", content: "hello" }]),
  ).rejects.toThrow(/did not complete|before successful completion/);
});

it.each([
  {
    selected: "my-model",
    expected: [
      "my-model",
      "google/gemma-4-31b-it:free",
      "openai/gpt-oss-120b:free",
      "openrouter/free",
    ],
  },
  {
    selected: "openrouter/free",
    expected: [
      "openrouter/free",
      "google/gemma-4-31b-it:free",
      "openai/gpt-oss-120b:free",
    ],
  },
  {
    selected: null,
    expected: [
      "google/gemma-4-31b-it:free",
      "openai/gpt-oss-120b:free",
      "openrouter/free",
    ],
  },
])(
  "generates a title through the regular fallback chain for $selected",
  async ({ selected, expected }) => {
    vi.resetModules();
    vi.stubEnv("PRIMARY_LLM_BASE_URL", "https://primary.test/v1");
    vi.stubEnv("OPENROUTER_BASE_URL", "https://openrouter.test/v1");
    vi.stubEnv("OPENROUTER_API_KEY", "test");
    const fetchMock = vi.fn();
    for (let index = 1; index < expected.length; index++) {
      fetchMock.mockResolvedValueOnce(
        new Response("Unavailable", { status: 503 }),
      );
    }
    fetchMock.mockResolvedValueOnce(
      response(
        textEvents.map((event) =>
          event.type === "response.output_text.delta"
            ? { ...event, delta: "Lease Renewal Terms" }
            : event,
        ),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { generateChatTitle } = await import("./chat-title");
    await expect(
      generateChatTitle("Explain my lease renewal.", {
        primaryModel: selected,
        signal: new AbortController().signal,
      }),
    ).resolves.toBe("Lease Renewal Terms");

    const requests = fetchMock.mock.calls.map(([, init]) =>
      JSON.parse(init.body),
    );
    expect(requests.map((request) => request.model)).toEqual(expected);
    for (const request of requests) {
      expect(request.stream).toBe(true);
      expect(request.store).toBe(false);
      expect(request.tools ?? []).toEqual([]);
    }
    expect(String(fetchMock.mock.calls[0]![0])).toBe(
      selected === "my-model"
        ? "https://primary.test/v1/responses"
        : "https://openrouter.test/v1/responses",
    );
    expect(String(fetchMock.mock.calls.at(-1)![0])).toBe(
      "https://openrouter.test/v1/responses",
    );
  },
);
