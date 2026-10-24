import { beforeEach, describe, expect, it, vi } from "vitest";
import { MockLanguageModelV4 } from "ai/test";
import { simulateReadableStream, tool } from "ai";
import { z } from "zod";

const mocks = vi.hoisted(() => ({ search: vi.fn() }));
vi.mock("./web-search", () => ({ searchWeb: mocks.search }));
import {
  generateChatReply,
  type ChatMessage,
  type ChatToolExtension,
} from "./chat";
import { CONTRACT_EGRESS_ERROR } from "./chat-tools";

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
      { type: "text-delta", id: "text", delta: "Done" },
      { type: "text-end", id: "text" },
    ],
    "stop",
  );
function scripted(steps: StepResult[]) {
  const queue = [...steps];
  return new MockLanguageModelV4({ doStream: async () => queue.shift() ?? answer() });
}

const note =
  "Private note: the launch code phrase is purple monkey dishwasher at nine tonight.";
const leak = "what does launch code phrase is purple monkey dishwasher at nine mean";

/** A fake application tool that reads private text, like SignLoop's read_contract. */
function notesExtension(options: { offered?: boolean } = {}): ChatToolExtension {
  return {
    toolNames: ["read_note"],
    privateResults: true,
    describeInput: (_name, input) =>
      `note ${(input as { id?: string }).id ?? ""}`.trim(),
    ...(options.offered === false
      ? {}
      : {
          note: "Use read_note to read the user's private notes.",
          createTools: ({ signal, egressGuard, onEvidence, onContractEvidence }) => ({
            read_note: tool({
              description: "Read one of the user's notes.",
              inputSchema: z.object({ id: z.string() }),
              execute: async ({ id }) => {
                signal.throwIfAborted();
                egressGuard.addContractText(note);
                onEvidence(note);
                onContractEvidence({ id, revision: "r1" });
                return { id, content: note };
              },
            }),
          }),
        }),
  };
}

function run(
  model: MockLanguageModelV4,
  messages: ChatMessage[],
  extensions: ChatToolExtension[],
) {
  return generateChatReply(messages, {
    providers: [
      { kind: "language-model", provider: "test", model: "mock", languageModel: model },
    ],
    tools: { webSearch: {}, extensions },
  });
}

beforeEach(() => {
  mocks.search.mockReset();
  mocks.search.mockImplementation(async (query: string) => ({
    provider: "brave",
    query,
    brief: null,
    results: [],
  }));
});

describe("tool extensions", () => {
  it("adds extension tools that feed the egress guard and contract evidence", async () => {
    const model = scripted([
      call("c1", "read_note", { id: "note-1" }),
      call("c2", "search_web", { query: leak }),
      call("c3", "search_web", { query: "public launch schedule" }),
    ]);
    const reply = await run(model, [{ role: "user", content: "Check my note" }], [
      notesExtension(),
    ]);

    expect(model.doStreamCalls[0]?.tools?.map((item) => item.name)).toEqual([
      "search_web",
      "read_note",
    ]);
    expect(JSON.stringify(model.doStreamCalls[0]?.prompt)).toContain(
      "Use read_note to read the user's private notes.",
    );
    expect(mocks.search.mock.calls.map(([query]) => query)).toEqual([
      "public launch schedule",
    ]);
    expect(JSON.stringify(model.doStreamCalls[2]?.prompt)).toContain(
      CONTRACT_EGRESS_ERROR,
    );
    expect(
      reply.toolActivity?.map(({ tool, query, status }) => [tool, query, status]),
    ).toEqual([
      ["read_note", "note note-1", "complete"],
      ["search_web", leak, "error"],
      ["search_web", "public launch schedule", "complete"],
    ]);
    expect(reply.contractEvidence).toEqual([{ id: "note-1", revision: "r1" }]);
  });

  it("seeds the guard from replayed private results even when the tools are not offered", async () => {
    const history = (toolName: string): ChatMessage[] => [
      { role: "user", content: "Read my note" },
      {
        role: "assistant",
        content: "Read it.",
        contractEvidence: [{ id: "note-1", revision: "r1" }],
        agentMessages: [
          {
            role: "assistant",
            content: [{ type: "tool-call", toolCallId: "old", toolName, input: { id: "note-1" } }],
          },
          {
            role: "tool",
            content: [
              {
                type: "tool-result",
                toolCallId: "old",
                toolName,
                output: { type: "json", value: { content: note } },
              },
            ],
          },
        ],
      },
      { role: "user", content: "Search for that phrase" },
    ];

    const guarded = scripted([call("c1", "search_web", { query: leak })]);
    const reply = await run(guarded, history("read_note"), [
      notesExtension({ offered: false }),
    ]);
    expect(guarded.doStreamCalls[0]?.tools?.map((item) => item.name)).toEqual([
      "search_web",
    ]);
    expect(mocks.search).not.toHaveBeenCalled();
    expect(reply.toolActivity?.[0]?.status).toBe("error");
    // Receipts from earlier turns are carried into the reply.
    expect(reply.contractEvidence).toEqual([{ id: "note-1", revision: "r1" }]);

    // Results of tools that are not marked private do not restrict outbound requests.
    const open = scripted([call("c1", "search_web", { query: leak })]);
    await run(open, history("read_page"), [notesExtension({ offered: false })]);
    expect(mocks.search).toHaveBeenCalledOnce();
  });

  it("reports only engine and extension tools as activity", async () => {
    const model = scripted([call("c1", "read_note", { id: "n" })]);
    const reply = await run(model, [{ role: "user", content: "Hi" }], []);
    // Without the extension the call fails as an unknown tool and is not reported.
    expect(reply.toolActivity).toEqual([]);
  });

  it("ends the turn at its deadline even when a tool ignores the signal", async () => {
    const model = scripted([call("c1", "hang", {})]);
    const controller = new AbortController();
    const hanging: ChatToolExtension = {
      toolNames: ["hang"],
      createTools: () => ({
        hang: tool({
          description: "Never finishes.",
          inputSchema: z.object({}),
          execute: (): Promise<string> => new Promise(() => {}),
        }),
      }),
    };
    setTimeout(() => controller.abort(new Error("turn deadline")), 50);
    const started = performance.now();
    await expect(
      generateChatReply([{ role: "user", content: "Hi" }], {
        providers: [{ kind: "language-model", provider: "test", model: "mock", languageModel: model }],
        tools: { extensions: [hanging] },
        signal: controller.signal,
        rethrowAbortReason: true,
      }),
    ).rejects.toThrow("turn deadline");
    expect(performance.now() - started).toBeLessThan(2000);
  });
});

