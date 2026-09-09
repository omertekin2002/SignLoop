import { afterEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ search: vi.fn() }));
vi.mock("@/lib/gemini-search", () => ({ searchWeb: mocks.search }));
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
    brief: "Verified evidence",
    metadata: {
      query: "current rates",
      attemptedQueries: ["current rates"],
      successfulSearches: 1,
      sources: [{ title: "Source", url: "https://source.test" }],
    },
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
