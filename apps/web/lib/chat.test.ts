import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MockLanguageModelV4 } from "ai/test";
import { simulateReadableStream } from "ai";
import { validateContractReplay } from "./contract-evidence";

// SignLoop's binding of the chat engine: its provider chain and the contract-tool extension.
// Generic agent-loop behavior is tested in packages/chat-engine.
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
vi.mock("@/lib/model-settings", () => ({
  IMAGE_GENERATION_MODEL: "image-model",
  orderOpenRouterModels: (pinned: string) =>
    pinned === "openrouter/free" ? [pinned, "fallback"] : ["fallback"],
}));
vi.mock("@repo/chat-engine/web-search", () => ({ searchWeb: mocks.search }));
vi.mock("@repo/chat-engine/url-reader", () => ({ readUrl: mocks.readUrl }));
vi.mock("@repo/chat-engine/image-generation", () => ({
  generateImageReply: mocks.generateImage,
}));
vi.mock("@/lib/server-db", () => ({
  listContractsForChat: mocks.listContracts,
  getContractTextForUser: mocks.getContractText,
  getContractWindowForUser: mocks.getContractText,
}));
vi.mock("@/lib/llm-client", () => ({
  APP_NAME: "SignLoop",
  SITE_URL: "https://signloop.test",
  PRIMARY_LLM_BASE_URL: "https://primary.test/v1",
  PRIMARY_LLM_API_KEY: "test",
  OPENROUTER_BASE_URL: "https://fallback.test/v1",
  OPENROUTER_API_KEY: "test",
  OPENROUTER_MODELS: ["fallback"],
  isOpenRouterModel: (model: unknown) => model === "openrouter/free",
  resolvePrimaryModel: (value: string | null | undefined) =>
    value === null ? null : (value ?? "primary"),
}));
import { generateChatReply } from "./chat";

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

describe("SignLoop chat", () => {
  it("reads a chat attachment and creates a download without replaying file bytes", async () => {
    const id = "11111111-1111-4111-8111-111111111111";
    const text = "The invoice requires payment within thirty days.";
    const model = sequencedModel([
      toolStep(0, "read_file", { fileId: id }),
      toolStep(1, "create_file", { name: "Summary", format: "txt", content: "Payment is due in thirty days." }),
    ]);
    mocks.responses.mockReturnValue(model);
    const reply = await generateChatReply([{ role: "user", content: "Summarize the file as a download.", fileIds: [id] }], {
      enableDocuments: true,
      documents: [{ id, name: "invoice.txt", mediaType: "text/plain", size: text.length, text }],
    });
    expect(JSON.stringify(model.doStreamCalls[0]!.prompt)).toContain("invoice.txt");
    expect(JSON.stringify(model.doStreamCalls[0]!.prompt)).not.toContain(text);
    expect(JSON.stringify(model.doStreamCalls[1]!.prompt)).toContain(text);
    expect(reply.files).toHaveLength(1);
    expect(Buffer.from(reply.files![0]!.data, "base64").toString()).toBe("Payment is due in thirty days.");
    expect(JSON.stringify(reply.agentMessages)).not.toContain(reply.files![0]!.data);
    expect(reply.toolActivity?.map((activity) => activity.tool)).toEqual(["read_file", "create_file"]);
    const { data: _bytes, ...document } = reply.files![0]!;
    const followup = sequencedModel([toolStep(0, "read_file", { fileId: document.id })]);
    mocks.responses.mockReturnValue(followup);
    await generateChatReply([
      { role: "assistant", content: reply.message, documents: [document] },
      { role: "user", content: "Revise your download" },
    ], { enableDocuments: true, documents: [document] });
    expect(JSON.stringify(followup.doStreamCalls[1]!.prompt)).toContain(document.text);
    expect(JSON.stringify(followup.doStreamCalls)).not.toContain(reply.files![0]!.data);
  });

  it("reads the user's contracts only when a user is attached", async () => {
    const contractId = "11111111-1111-4111-8111-111111111111";
    mocks.listContracts.mockResolvedValue({
      contracts: [
        {
          id: contractId,
          title: "NDA",
          status: "DRAFT",
          projectId: null,
          updatedAt: "2026-01-01",
          characterCount: 44,
          extractionWarning: null,
          revision: "v1",
        },
      ],
      nextOffset: null,
    });
    mocks.getContractText.mockResolvedValue({
      id: contractId,
      title: "NDA",
      status: "DRAFT",
      text: "Clause 1. Confidentiality lasts five years.",
      extractionWarning: null,
      revision: "v1",
    });
    const model = sequencedModel([
      toolStep(0, "list_contracts", {}),
      toolStep(1, "read_contract", { contractId, find: "confidentiality" }),
    ]);
    mocks.responses.mockReturnValue(model);
    const reply = await generateChatReply(messages, {
      contractsUserId: "user-1",
    });
    expect(mocks.listContracts).toHaveBeenCalledWith("user-1", {
      offset: undefined,
      query: undefined,
    });
    expect(mocks.getContractText).toHaveBeenCalledWith("user-1", contractId);
    expect(JSON.stringify(model.doStreamCalls[0]?.prompt)).toContain(
      "do not assert how a particular jurisdiction's law treats it",
    );
    expect(JSON.stringify(model.doStreamCalls[1]?.prompt)).toContain("NDA");
    expect(JSON.stringify(model.doStreamCalls[2]?.prompt)).toContain(
      "Confidentiality lasts",
    );
    expect(
      reply.toolActivity?.map((activity) => [activity.tool, activity.status]),
    ).toEqual([
      ["list_contracts", "complete"],
      ["read_contract", "complete"],
    ]);
    expect(reply.webSearch).toBeNull();
    expect(reply.contractEvidence).toEqual([{ id: contractId, revision: "v1" }]);
    const followup = scriptedModel();
    mocks.responses.mockReturnValue(followup);
    const continued = await generateChatReply([
      ...messages,
      { role: "assistant", content: reply.message, contractEvidence: reply.contractEvidence },
      { role: "user", content: "Explain the practical effect" },
    ], { contractsUserId: "user-1" });
    expect(continued.contractEvidence).toEqual(reply.contractEvidence);

    const anonymous = scriptedModel();
    mocks.responses.mockReturnValue(anonymous);
    await generateChatReply(messages, {});
    expect(anonymous.doStreamCalls[0]?.tools ?? []).toHaveLength(0);
    expect(JSON.stringify(anonymous.doStreamCalls[0]?.prompt)).toContain(
      "No tools are available",
    );
  });

  it("reports contract lookups that fail as tool errors", async () => {
    mocks.getContractText.mockResolvedValue(null);
    const model = sequencedModel([
      toolStep(0, "read_contract", {
        contractId: "11111111-1111-4111-8111-111111111111",
      }),
    ]);
    mocks.responses.mockReturnValue(model);
    const reply = await generateChatReply(messages, {
      contractsUserId: "user-1",
    });
    expect(reply.toolActivity?.[0]?.status).toBe("error");
    expect(JSON.stringify(model.doStreamCalls[1]?.prompt)).toContain(
      "Contract not found",
    );
  });

  it("records an explicit empty receipt list when contract tools read nothing", async () => {
    mocks.listContracts.mockResolvedValue({ contracts: [], nextOffset: null });
    mocks.getContractText.mockResolvedValue(null);
    mocks.responses.mockReturnValue(
      sequencedModel([
        toolStep(0, "list_contracts", { query: "lease" }),
        toolStep(1, "read_contract", {
          contractId: "11111111-1111-4111-8111-111111111111",
        }),
      ]),
    );
    const reply = await generateChatReply(messages, {
      contractsUserId: "user-1",
    });
    expect(
      reply.toolActivity?.map((activity) => [activity.tool, activity.status]),
    ).toEqual([
      ["list_contracts", "complete"],
      ["read_contract", "error"],
    ]);
    expect(reply.contractEvidence).toEqual([]);
    // The metadata the saved-chat route stores for this reply stays replayable.
    const saved = {
      agentMessages: reply.agentMessages,
      contractEvidence: reply.contractEvidence,
      toolActivity: reply.toolActivity,
    };
    expect(validateContractReplay(saved, new Map())).toBe(saved);
  });

  describe("contract egress guard", () => {
    const contractId = "11111111-1111-4111-8111-111111111111";
    const clause =
      "Clause 4.\nKeep all Confidential Information strictly secret for five years after termination.";
    const leak = "keep all confidential information strictly secret for five";

    it("blocks a search carrying contract text read in this turn, but not the next turn", async () => {
      mocks.getContractText.mockResolvedValue({
        id: contractId,
        title: "NDA",
        status: "DRAFT",
        text: clause,
        extractionWarning: null,
      revision: "v1",
      });
      const model = sequencedModel([
        toolStep(0, "read_contract", { contractId, find: "confidential" }),
        toolStep(1, "search_web", { query: leak }),
        toolStep(2, "search_web", { query: "typical NDA confidentiality period" }),
      ]);
      mocks.responses.mockReturnValue(model);
      const reply = await generateChatReply(messages, {
        enableWebSearch: true,
        contractsUserId: "user-1",
      });
      expect(mocks.search.mock.calls.map((call) => call[0])).toEqual([
        "typical NDA confidentiality period",
      ]);
      expect(
        reply.toolActivity?.map((activity) => [activity.tool, activity.status]),
      ).toEqual([
        ["read_contract", "complete"],
        ["search_web", "error"],
        ["search_web", "complete"],
      ]);
      expect(JSON.stringify(model.doStreamCalls[2]?.prompt)).toContain(
        "repeats wording from the user's contract",
      );

      mocks.responses.mockReturnValue(
        sequencedModel([toolStep(0, "search_web", { query: leak })]),
      );
      const next = await generateChatReply(messages, {
        enableWebSearch: true,
        contractsUserId: "user-1",
      });
      expect(mocks.search).toHaveBeenLastCalledWith(leak, expect.anything());
      expect(next.toolActivity?.[0]?.status).toBe("complete");
    });

    it.each([
      [
        "clipped",
        {
          type: "text" as const,
          value: `${JSON.stringify({ type: "json", value: { content: clause } })}\n[Replay excerpt; read the source again for more detail.]`,
        },
      ],
      ["structured", { type: "json" as const, value: { content: clause } }],
    ])("blocks contract text replayed from an earlier turn (%s)", async (_label, output) => {
      mocks.responses.mockReturnValue(
        sequencedModel([toolStep(0, "search_web", { query: leak })]),
      );
      const reply = await generateChatReply(
        [
          { role: "user", content: "Summarise the NDA." },
          {
            role: "assistant",
            content: "It is a five-year NDA.",
            agentMessages: [
              {
                role: "assistant",
                content: [
                  {
                    type: "tool-call",
                    toolCallId: "earlier",
                    toolName: "read_contract",
                    input: { contractId },
                  },
                ],
              },
              {
                role: "tool",
                content: [
                  {
                    type: "tool-result",
                    toolCallId: "earlier",
                    toolName: "read_contract",
                    output,
                  },
                ],
              },
              { role: "assistant", content: "It is a five-year NDA." },
            ],
          },
          { role: "user", content: "Search the web for that clause." },
        ],
        { enableWebSearch: true, contractsUserId: "user-1" },
      );
      expect(mocks.search).not.toHaveBeenCalled();
      expect(reply.toolActivity?.[0]?.status).toBe("error");
    });
  });

  it("skips the primary endpoint when the user pins an OpenRouter model", async () => {
    const model = scriptedModel();
    mocks.responses.mockReturnValue(model);
    const reply = await generateChatReply(messages, {
      primaryModel: "openrouter/free",
    });
    expect(mocks.responses.mock.calls.map((call) => call[0])).toEqual([
      "openrouter/free",
      "fallback",
    ]);
    expect(reply).toMatchObject({
      provider: "openrouter",
      model: "openrouter/free",
    });
  });
});
